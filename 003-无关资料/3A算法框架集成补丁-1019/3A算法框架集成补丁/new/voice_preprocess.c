/*
 * Copyright (C) 2017 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file    voice_preprocess.c
 * @author  Sun Mingjun <smj@rock-chips.com>
 * @date    2017-05-08
 */

//#define LOG_NDEBUG 0

#include <pthread.h>
#include <semaphore.h>
#include <unistd.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/time.h>
#include <dlfcn.h>  // for dlopen/dlclose
#include <fcntl.h>

#include <cutils/log.h>
#include <cutils/properties.h>
#include <cutils/str_parms.h>

#include <speex/speex.h>
#include <speex/speex_preprocess.h>
#include <speex/speex_resampler.h>


#include "voice_preprocess.h"

#define LOG_TAG "voice_process"


#define MAX_BUFFER_SIZE (500 * 1024)
#define PROCESS_BUFFER_SIZE (320)
#define false (0)
#define true  (1)
#define bool  int


typedef struct voiceThread_t_ {
    bool            running;
    pthread_t       thread;
    sem_t           sem;
    int             threadStatus;
    pthread_mutex_t queueCapLock;
    pthread_mutex_t queuePlyLock;
    pthread_mutex_t getCapOutLock;
    pthread_mutex_t getPlyOutLock;
} voiceThread_t;

typedef struct rk_voice_api_ {
    short (*init)(short *para);
    void  (*processCapture)(short  *in, short *out, int len);
    void  (*processPlayback)(short *in, short *out, int len);
    void  (*deinit)();
} rk_voice_api;


typedef struct rk_voice_handle_ {
    void*   voiceLibHandle;
    rk_voice_api *voiceApi;
    rk_process_api *processApi;
    char*  playBackBuffer;
    char*  captureBuffer;
    char*  outPlayBuffer;
    char*  outCaptureBuffer;
    SpeexResamplerState* speexCapureDownResample;
    SpeexResamplerState* speexCapureUpResample;
    SpeexResamplerState* speexPlaybackDownResample;
    SpeexResamplerState* speexPlaybackUpResample;
    voiceThread_t voice_thread;
    int    playbackBufferSize;
    int    captureBufferSize;
    int    outPlaybackBufferSize;
    int    outCaptureBufferSize;
    int    captureInSamplerate;
    int    processSamplerate;
    int    playbackInSamplerate;
    int    captureInChannels;
    int    processChannels;
    int    playbackInChannels;
    int    processBuffersize;
    int    minPlaybackBuffersize;
    int    minCaptureBuffersize;
} rk_voice_handle;


static rk_voice_handle *voice_handle = NULL;
static int prop_pcm_record = 0;

static void thread_loop(rk_voice_handle* handle);
static void*  thread_start(void* argv);
static void voiceSetPara(short int *pshwPara, short int  shwLen);
static void dump_out_data(const void* buffer,size_t bytes, int *size)
{
    static FILE* fd = NULL;
    static int offset = 0;
    if(fd == NULL) {
        fd=fopen("/data/1.pcm","wb+");
        if(fd == NULL) {
            ALOGD("DEBUG open  error =%d ,errno = %d",fd,errno);
            offset = 0;
        }
    }
    fwrite(buffer,bytes,1,fd);
    offset += bytes;
    fflush(fd);
    if(offset >= (*size)*1024*1024) {
        *size = 0;
        fclose(fd);
        offset = 0;
    }
}

static inline rk_voice_handle* getHandle()
{
    return voice_handle;
}


static int start()
{
    rk_voice_handle* voiceHandle = getHandle();

    sem_init(&voice_handle->voice_thread.sem, 0, 1);
    voiceHandle->voice_thread.running = true;

    if (voiceHandle->voice_thread.threadStatus == -1)
        voiceHandle->voice_thread.threadStatus = pthread_create(&voiceHandle->voice_thread.thread, NULL, thread_start, voiceHandle);

    ALOGD("voice process start !, ret = %d", voiceHandle->voice_thread.threadStatus);

    return 0;
}

static int queueCaputureBuffer(void *buf, int size)
{
    rk_voice_handle* voiceHandle = getHandle();

    if (voiceHandle->playbackBufferSize <= 0) {
        ALOGV("not queue capture buffer until playback buffer queued");
        return -1;
    }

    pthread_mutex_lock(&voiceHandle->voice_thread.queueCapLock);
    if (voiceHandle->captureBufferSize + size >= MAX_BUFFER_SIZE) {
        ALOGW("capture buffer size out of range, flush");
        memset(voiceHandle->captureBuffer, 0x00, MAX_BUFFER_SIZE);
        voiceHandle->captureBufferSize = 0;
    }
    memcpy((char *)voiceHandle->captureBuffer + voiceHandle->captureBufferSize, (char *)buf, size);
    voiceHandle->captureBufferSize += size;
    pthread_mutex_unlock(&voiceHandle->voice_thread.queueCapLock);


    if ((voiceHandle->captureBufferSize >= voiceHandle->minCaptureBuffersize)
            && (voiceHandle->playbackBufferSize >= voiceHandle->minPlaybackBuffersize)) {
        sem_post(&voiceHandle->voice_thread.sem);
    }
    return 0;
}

static int queuePlaybackBuffer(void *buf, int size)
{
    rk_voice_handle* voiceHandle = getHandle();

    pthread_mutex_lock(&voiceHandle->voice_thread.queuePlyLock);
    if (voiceHandle->playbackBufferSize + size >= MAX_BUFFER_SIZE) {
        ALOGW("capture buffer size out of range, flush");
        memset(voiceHandle->playBackBuffer, 0x00, MAX_BUFFER_SIZE);
        voiceHandle->playbackBufferSize = 0;
    }
    memcpy((char *)voiceHandle->playBackBuffer+ voiceHandle->playbackBufferSize, (char *)buf, size);
    voiceHandle->playbackBufferSize+= size;
    pthread_mutex_unlock(&voiceHandle->voice_thread.queuePlyLock);

    if ((voiceHandle->captureBufferSize >= voiceHandle->minCaptureBuffersize)
            && (voiceHandle->playbackBufferSize >= voiceHandle->minPlaybackBuffersize)) {
        sem_post(&voiceHandle->voice_thread.sem);
    }
    return 0;
}

static int getCapureBuffer(void *buf, int size)
{
    rk_voice_handle* voiceHandle = getHandle();

    if (voiceHandle->outCaptureBufferSize < size) {
        ALOGW("cannot get caputre buffer currently, try next time");
        return -1;
    }
    pthread_mutex_lock(&voiceHandle->voice_thread.getCapOutLock);
    memcpy((char *)buf, voiceHandle->outCaptureBuffer, size);
    memcpy(voiceHandle->outCaptureBuffer, voiceHandle->outCaptureBuffer+size, MAX_BUFFER_SIZE-size);
    voiceHandle->outCaptureBufferSize -= size;
    pthread_mutex_unlock(&voiceHandle->voice_thread.getCapOutLock);
    return 0;
}

static int getPlaybackBuffer(void *buf, int size)
{
    rk_voice_handle* voiceHandle = getHandle();

    if (voiceHandle->outPlaybackBufferSize < size) {
        ALOGW("cannot get playback buffer currently, try next time");
        return -1;
    }
    pthread_mutex_lock(&voiceHandle->voice_thread.getPlyOutLock);
    memcpy((char *)buf, (char *)voiceHandle->outPlayBuffer, size);
    memcpy((char *)voiceHandle->outPlayBuffer, (char *)voiceHandle->outPlayBuffer+size, MAX_BUFFER_SIZE-size);
    voiceHandle->outPlaybackBufferSize -= size;
    pthread_mutex_unlock(&voiceHandle->voice_thread.getPlyOutLock);

    return 0;
}

static int flush()
{
    rk_voice_handle* voiceHandle = getHandle();

    pthread_mutex_lock(&voiceHandle->voice_thread.queuePlyLock);
    memset((char *)voiceHandle->playBackBuffer, 0x00, MAX_BUFFER_SIZE);
    voiceHandle->playbackBufferSize = 0;
    pthread_mutex_unlock(&voiceHandle->voice_thread.queuePlyLock);

    pthread_mutex_lock(&voiceHandle->voice_thread.queueCapLock);
    memset((char *)voiceHandle->captureBuffer, 0x00, MAX_BUFFER_SIZE);
    voiceHandle->captureBufferSize = 0;
    pthread_mutex_unlock(&voiceHandle->voice_thread.queueCapLock);

    return 0;
}


rk_process_api* rk_voiceprocess_create(int ply_sr, int ply_ch, int cap_sr, int cap_ch)
{
    if (voice_handle != NULL) {
        ALOGW(" voice handle has already opened, return");
        return voice_handle->processApi;
    }

    voice_handle = (rk_voice_handle *)malloc(sizeof(rk_voice_handle));

    if (voice_handle== NULL) {
        ALOGE("voice Handle malloc failed!");
        goto failed;
    }

    voice_handle->voiceLibHandle        = NULL;
    voice_handle->voiceApi              = NULL;
    voice_handle->processApi            = NULL;
    voice_handle->playBackBuffer        = NULL;
    voice_handle->captureBuffer         = NULL;
    voice_handle->speexCapureDownResample   = NULL;
    voice_handle->speexCapureUpResample     = NULL;
    voice_handle->speexPlaybackDownResample = NULL;
    voice_handle->speexPlaybackUpResample   = NULL;
    voice_handle->playbackBufferSize     = 0;
    voice_handle->captureBufferSize      = 0;
    voice_handle->outPlaybackBufferSize  = 0;
    voice_handle->outCaptureBufferSize   = 0;
    voice_handle->captureInSamplerate    = cap_sr;
    voice_handle->processSamplerate      = 16000;
    voice_handle->playbackInSamplerate   = ply_sr;
    voice_handle->captureInChannels      = cap_ch;
    voice_handle->processChannels        = 1;
    voice_handle->playbackInChannels     = ply_ch;

    voice_handle->minPlaybackBuffersize = PROCESS_BUFFER_SIZE * 2 * voice_handle->playbackInSamplerate / voice_handle->processSamplerate * voice_handle->playbackInChannels;
    voice_handle->minCaptureBuffersize = PROCESS_BUFFER_SIZE * 2 * voice_handle->captureInSamplerate / voice_handle->processSamplerate * voice_handle->captureInChannels;

    voice_handle->voice_thread.running = false;
    voice_handle->voice_thread.threadStatus = -1;

    // open the voice process lib
    voice_handle->voiceLibHandle = dlopen("/system/lib/libvoiceprocess.so", RTLD_LAZY);
    if (voice_handle->voiceLibHandle == NULL) {
        ALOGW("dlopen libvoiceprocess lib error!");
        goto failed;
    }
    voice_handle->voiceApi = (rk_voice_api *)malloc(sizeof(rk_voice_api));
    if (voice_handle->voiceApi == NULL) {
        ALOGE("voiceApi malloc error!  return");
        goto failed;
    }

    memset(voice_handle->voiceApi, 0, sizeof(rk_voice_api));

    voice_handle->voiceApi->init = (short (*)(short *))dlsym(voice_handle->voiceLibHandle,
                                   "VOICE_Init");
    voice_handle->voiceApi->processCapture = (void (*)(short  *in,
            short *out,
            int len))dlsym(voice_handle->voiceLibHandle,
                           "VOICE_ProcessTx");
    voice_handle->voiceApi->processPlayback = (void (*)(short  *in,
            short *out,
            int len))dlsym(voice_handle->voiceLibHandle,
                           "VOICE_ProcessRx");
    voice_handle->voiceApi->deinit= (void (*)())dlsym(voice_handle->voiceLibHandle,
                                    "VOICE_Destory");

    if ((voice_handle->voiceApi->init == NULL)
            || (voice_handle->voiceApi->processCapture == NULL)
            || (voice_handle->voiceApi->processPlayback == NULL)
            || (voice_handle->voiceApi->deinit == NULL)) {
        ALOGE("dlsym voice process lib failed, return");
        goto failed;
    }

    // init parameters
    short int ashwPara[500] = {0};
    voiceSetPara(ashwPara, 500);

    // init the voice process lib
    int ret = 0;
    ret = voice_handle->voiceApi->init(ashwPara);
    ALOGD("voice api init ret = %d", ret);
    if (ret == 1) {
        ALOGE("not for rockchip!");
    }

    // init the processApi interface
    voice_handle->processApi = (rk_process_api *)malloc(sizeof(rk_process_api));
    voice_handle->processApi->start = start;
    voice_handle->processApi->getCapureBuffer = getCapureBuffer;
    voice_handle->processApi->getPlaybackBuffer = getPlaybackBuffer;
    voice_handle->processApi->queuePlaybackBuffer = queuePlaybackBuffer;
    voice_handle->processApi->quueCaputureBuffer = queueCaputureBuffer;
    voice_handle->processApi->flush = flush;

    // malloc process buffers
    voice_handle->playBackBuffer = (char *)malloc(MAX_BUFFER_SIZE);
    voice_handle->captureBuffer = (char *)malloc(MAX_BUFFER_SIZE);
    voice_handle->outPlayBuffer = (char *)malloc(MAX_BUFFER_SIZE);
    voice_handle->outCaptureBuffer = (char *)malloc(MAX_BUFFER_SIZE);

    if ((voice_handle->playBackBuffer == NULL) || (voice_handle->captureBuffer == NULL)
            ||(voice_handle->outPlayBuffer == NULL) || (voice_handle->outCaptureBuffer == NULL)) {
        ALOGE("malloc playback or capure buffer falied!");
        goto failed;
    }

    pthread_mutex_init(&voice_handle->voice_thread.queuePlyLock, NULL);
    pthread_mutex_init(&voice_handle->voice_thread.queueCapLock, NULL);
    pthread_mutex_init(&voice_handle->voice_thread.getCapOutLock, NULL);
    pthread_mutex_init(&voice_handle->voice_thread.getPlyOutLock, NULL);

    if (voice_handle->captureInSamplerate != voice_handle->processSamplerate) {
        voice_handle->speexCapureDownResample = speex_resampler_init(1, voice_handle->captureInSamplerate, voice_handle->processSamplerate, SPEEX_RESAMPLER_QUALITY_DESKTOP, NULL);
        voice_handle->speexCapureUpResample = speex_resampler_init(1, voice_handle->processSamplerate, voice_handle->captureInSamplerate, SPEEX_RESAMPLER_QUALITY_DESKTOP, NULL);
    }

    if (voice_handle->playbackInSamplerate!= voice_handle->processSamplerate) {
        voice_handle->speexPlaybackDownResample = speex_resampler_init(1, voice_handle->playbackInSamplerate, voice_handle->processSamplerate, SPEEX_RESAMPLER_QUALITY_DESKTOP, NULL);
        voice_handle->speexPlaybackUpResample = speex_resampler_init(1, voice_handle->processSamplerate, voice_handle->playbackInSamplerate, SPEEX_RESAMPLER_QUALITY_DESKTOP, NULL);
    }

    ALOGD("voice proceess handle create success!");

    return voice_handle->processApi;

failed :

    rk_voiceprocess_destory();
    ALOGD("voice process handle create failed");
    return NULL;
}


int rk_voiceprocess_destory()
{
    ALOGD("voiceprocess_destory");
    if (voice_handle == NULL) {
        ALOGD("voiceprocess_destory return");
        return 0;
    }
    if (voice_handle->voice_thread.threadStatus >= 0) {
        voice_handle->voice_thread.running = false;
        sem_post(&voice_handle->voice_thread.sem);
        ALOGD("join thread in");
        pthread_join(voice_handle->voice_thread.thread, NULL);
        voice_handle->voice_thread.threadStatus = -1;
        ALOGD("join thread out");

        sem_destroy(&voice_handle->voice_thread.sem);
    }

    if (voice_handle->speexCapureDownResample) {
        speex_resampler_destroy(voice_handle->speexCapureDownResample);
        voice_handle->speexCapureDownResample = NULL;
    }

    if (voice_handle->speexCapureDownResample) {
        speex_resampler_destroy(voice_handle->speexCapureDownResample);
        voice_handle->speexCapureDownResample = NULL;
    }

    if (voice_handle->speexPlaybackUpResample) {
        speex_resampler_destroy(voice_handle->speexPlaybackUpResample);
        voice_handle->speexPlaybackUpResample = NULL;
    }

    if (voice_handle->speexPlaybackDownResample) {
        speex_resampler_destroy(voice_handle->speexPlaybackDownResample);
        voice_handle->speexPlaybackDownResample = NULL;
    }

    if (voice_handle->playBackBuffer != NULL) {
        pthread_mutex_lock(&voice_handle->voice_thread.queuePlyLock);
        free(voice_handle->playBackBuffer);
        voice_handle->playBackBuffer = NULL;
        voice_handle->playbackBufferSize = 0;
        pthread_mutex_unlock(&voice_handle->voice_thread.queuePlyLock);
    }

    if (voice_handle->captureBuffer != NULL) {
        pthread_mutex_lock(&voice_handle->voice_thread.queueCapLock);
        free(voice_handle->captureBuffer);
        voice_handle->captureBuffer = NULL;
        voice_handle->captureBufferSize = 0;
        pthread_mutex_unlock(&voice_handle->voice_thread.queueCapLock);
    }

    if (voice_handle->outPlayBuffer != NULL) {
        pthread_mutex_lock(&voice_handle->voice_thread.getPlyOutLock);
        free(voice_handle->outPlayBuffer);
        voice_handle->outPlayBuffer = NULL;
        voice_handle->outPlaybackBufferSize = 0;
        pthread_mutex_unlock(&voice_handle->voice_thread.getPlyOutLock);
    }

    if (voice_handle->outCaptureBuffer != NULL) {
        pthread_mutex_lock(&voice_handle->voice_thread.getCapOutLock);
        free(voice_handle->outCaptureBuffer);
        voice_handle->outCaptureBuffer = NULL;
        voice_handle->outCaptureBufferSize = 0;
        pthread_mutex_unlock(&voice_handle->voice_thread.getCapOutLock);
    }

    if (voice_handle->processApi) {
        free(voice_handle->processApi);
        voice_handle->processApi = NULL;
    }

    if (voice_handle->voiceApi) {
        voice_handle->voiceApi->deinit();
    }

    if (voice_handle->voiceApi != NULL) {
        free(voice_handle->voiceApi);
        voice_handle->voiceApi = NULL;
    }
    if (voice_handle->voiceLibHandle != NULL) {
        dlclose(voice_handle->voiceLibHandle);
        voice_handle->voiceLibHandle = NULL;
    }

    if (voice_handle != NULL) {
        free(voice_handle);
        voice_handle = NULL;
    }
    ALOGD("voice process handle destory success!");
    return 0;
}


static int processBuffertoMono(void *buffer, int size)
{
    short *in = (short *)buffer;
    short out[size/4];
    int i = 0, j = 0;

    for(i = 0, j = 0; i < size/4; i++) {
        out[i] = (in[j] + in[j+1]) / 2;
        j+=2;
    }
    memset((char *)in, 0x00, size);
    memcpy((char *)in, (char *)out, size/2);
    return 0;
}

static int processBuffertoStereo(void *buffer, int size)
{
    short *in = (short *)buffer;
    short out[size];
    int i = 0,j = 0;;

    for (i = 0, j = 0; i < size/2; i++) {
        out[j] = in[i];
        out[j+1] = in[i];
        j+=2;
    }
    memcpy((char *)in, (char *)out, size * 2);
    return 0;
}


static void thread_loop(rk_voice_handle* handle)
{
    int playback_samplerate = handle->playbackInSamplerate;
    int capture_samplerate = handle->captureInSamplerate;
    int process_samplerate = handle->processSamplerate;
    int playback_channel = handle->playbackInChannels;
    int capture_channel = handle->captureInChannels;
    int process_buffer_size = PROCESS_BUFFER_SIZE * 2;

    int playback_min_buffersize = process_buffer_size * playback_samplerate / process_samplerate * playback_channel;
    int capture_min_buffersize = process_buffer_size * capture_samplerate / process_samplerate * capture_channel;

    char tmp_playback_buffer[playback_min_buffersize];
    char tmp_capture_buffer[capture_min_buffersize];

    char tmp_outplayback_buffer[playback_min_buffersize];
    char tmp_outcapture_buffer[capture_min_buffersize];

    while (handle->voice_thread.running) {

        bool isGetBuffer = false;

        //wait the enough raw buffer
        if ((handle->captureBufferSize < capture_min_buffersize) || (handle->playbackBufferSize < playback_min_buffersize)) {
            sem_wait(&handle->voice_thread.sem);
        }

        char value[PROPERTY_VALUE_MAX] = "";
        property_get("media.audio.record", value, NULL);
        prop_pcm_record = atoi(value);

        // try to get the raw buffer to process
        if ((handle->captureBufferSize >= capture_min_buffersize) && (handle->playbackBufferSize >= playback_min_buffersize)) {
            pthread_mutex_lock(&handle->voice_thread.queueCapLock);
            memcpy(tmp_capture_buffer, handle->captureBuffer, capture_min_buffersize);
            memcpy(handle->captureBuffer, handle->captureBuffer+capture_min_buffersize, MAX_BUFFER_SIZE-capture_min_buffersize);
            handle->captureBufferSize -= capture_min_buffersize;
            pthread_mutex_unlock(&handle->voice_thread.queueCapLock);

            pthread_mutex_lock(&handle->voice_thread.queuePlyLock);
            memcpy(tmp_playback_buffer, handle->playBackBuffer, playback_min_buffersize);
            memcpy(handle->playBackBuffer, handle->playBackBuffer+playback_min_buffersize, MAX_BUFFER_SIZE-playback_min_buffersize);
            handle->playbackBufferSize -= playback_min_buffersize;
            pthread_mutex_unlock(&handle->voice_thread.queuePlyLock);
            isGetBuffer = true;
        }

        // process the raw buffer and queue to output list
        if (isGetBuffer) {
            // process buffer to mono
            if (playback_channel > 1) {
                processBuffertoMono(tmp_playback_buffer, playback_min_buffersize);
            }

            if (capture_channel > 1) {
                processBuffertoMono(tmp_capture_buffer, capture_min_buffersize);
            }

            // resample raw buffer to processed samplerate
            if (playback_samplerate != process_samplerate) {
                int in_sample = playback_min_buffersize / playback_channel / 2;
                int out_sample = in_sample;
                char tmp_resample_buffer[playback_min_buffersize];

                memcpy(tmp_resample_buffer, tmp_playback_buffer, playback_min_buffersize);
                memset(tmp_playback_buffer, 0x00, playback_min_buffersize);
                speex_resampler_process_interleaved_int(handle->speexPlaybackDownResample,
                                                        (spx_int16_t *)tmp_resample_buffer, &in_sample,
                                                        (spx_int16_t *)tmp_playback_buffer, &out_sample);
                ALOGV("playback down resample process, in_sample = %d, out_sample = %d", in_sample, out_sample);
            }

            if (capture_samplerate != process_samplerate) {
                int in_sample = capture_min_buffersize / capture_channel / 2;
                int out_sample = in_sample;
                char tmp_resample_buffer[playback_min_buffersize];
                memcpy(tmp_resample_buffer, tmp_capture_buffer, capture_min_buffersize);
                memset(tmp_capture_buffer, 0x00, capture_min_buffersize);
                speex_resampler_process_interleaved_int(handle->speexCapureDownResample,
                                                        (spx_int16_t *)tmp_resample_buffer, &in_sample,
                                                        (spx_int16_t *)tmp_capture_buffer, &out_sample);
                ALOGV("capture down resample process, in_sample = %d, out_sample = %d", in_sample, out_sample);
            }

            // main process call
            if (handle->voiceApi) {
                //memcpy((char *)tmp_outplayback_buffer, (char *)tmp_playback_buffer, PROCESS_BUFFER_SIZE * 2);
                //memcpy((char *)tmp_outcapture_buffer, (char *)tmp_capture_buffer, PROCESS_BUFFER_SIZE * 2);
                handle->voiceApi->processPlayback((short *)tmp_playback_buffer, (short *)tmp_outplayback_buffer, PROCESS_BUFFER_SIZE);
                handle->voiceApi->processCapture((short *)tmp_capture_buffer, (short *)tmp_outcapture_buffer, PROCESS_BUFFER_SIZE);
            }

            // upresample the processed buffer to raw buffer samplerate
            if (playback_samplerate != process_samplerate) {
                int in_sample = PROCESS_BUFFER_SIZE;
                int out_sample = playback_min_buffersize;
                memset(tmp_playback_buffer, 0x00, playback_min_buffersize);
                memcpy(tmp_playback_buffer, tmp_outplayback_buffer, process_buffer_size);
                speex_resampler_process_interleaved_int(handle->speexPlaybackUpResample,
                                                        (spx_int16_t *)tmp_playback_buffer, &in_sample,
                                                        (spx_int16_t *)tmp_outplayback_buffer, &out_sample);
                ALOGV("playback up resample process, in_sample = %d, out_sample = %d", in_sample, out_sample);

            }

            if (capture_samplerate != process_samplerate) {
                int in_sample = PROCESS_BUFFER_SIZE;
                int out_sample = capture_min_buffersize;
                memset(tmp_capture_buffer, 0x00, capture_min_buffersize);
                memcpy(tmp_capture_buffer, tmp_outcapture_buffer, process_buffer_size);
                speex_resampler_process_interleaved_int(handle->speexCapureUpResample,
                                                        (spx_int16_t *)tmp_capture_buffer, &in_sample,
                                                        (spx_int16_t *)tmp_outcapture_buffer, &out_sample);
                ALOGV("capture up resample process, in_sample = %d, out_sample = %d", in_sample, out_sample);
            }

            // up adjust channel to raw buffer channels
            if (playback_channel > 1) {
                processBuffertoStereo(tmp_outplayback_buffer, playback_min_buffersize/2);
            }

            if (capture_channel > 1) {
                processBuffertoStereo(tmp_outcapture_buffer, capture_min_buffersize/2);
            }

            // queue processed buffer to output list
            pthread_mutex_lock(&handle->voice_thread.getCapOutLock);
            memcpy((char *)handle->outCaptureBuffer + handle->outCaptureBufferSize, tmp_outcapture_buffer, capture_min_buffersize);
            handle->outCaptureBufferSize += capture_min_buffersize;
            pthread_mutex_unlock(&handle->voice_thread.getCapOutLock);

            pthread_mutex_lock(&handle->voice_thread.getPlyOutLock);
            memcpy((char *)handle->outPlayBuffer + handle->outPlaybackBufferSize, tmp_outplayback_buffer, playback_min_buffersize);
            handle->outPlaybackBufferSize += playback_min_buffersize;
            pthread_mutex_unlock(&handle->voice_thread.getPlyOutLock);
        }
    }

}

static void*  thread_start(void* argv)
{
    rk_voice_handle* handle = (rk_voice_handle*)argv;

    thread_loop(handle);

    return NULL;
}


static void voiceSetPara(short int *pshwPara, short int  shwLen)
{
    short int shwCnt;

    for (shwCnt=0; shwCnt<shwLen; shwCnt++) {
        pshwPara[shwCnt] = 0;
    }
#if 1
    /*------ 0.总模块参数设置 ------*/
    pshwPara[0] = 16000;                           /* INT16 Q0  采样率设置；当前仅支持8000,16000 */
    pshwPara[1] = 320;                             /* INT16 Q0  处理帧长设置；8k:160；16k:320 */

    /*------ 1.AEC 参数设置 ------*/
    pshwPara[10] = 1;                              /*           使能标志：回声消除使能 */
    pshwPara[11] = 320;                            /* INT16 Q0  处理帧长设置；8k:160；16k:320 */
    pshwPara[12] = 4000;                           /* INT16 Q0  默认延时设置(单位样点数),0到6400 */
    pshwPara[13] = 1;                              /*           使能标志：延时估计使能 */
    pshwPara[14] = 160;                            /* INT16 Q0  延时估计处理帧长；8k:80；16k:160 */
    pshwPara[15] = 40;                             /* INT16 Q0  最大delay帧数设置，一帧10ms；当前固定值 */
    pshwPara[16] = 0;                              /* INT16 Q0  反向超前帧数，一帧10ms；当前固定值 0 */
    pshwPara[17] = 320;                            /* INT16 Q0  MDF处理帧长设置；当前固定值 8k:160；16k:320 */
    pshwPara[18] = 640;                            /* INT16 Q0  MDF拖尾长度设置，即滤波长度；当前固定值 8k:320；16k:640 */
    pshwPara[19] = 16000;                          /* INT16 Q0  MDF采样率设置；当前固定值 8k,16k */
    pshwPara[20] = 320;                            /* INT16 Q0  NLP处理帧长设置；当前固定值 8k:160；16k:320 */	pshwPara[21] = 32;                             /* INT16 Q0  NLP处理子带设置；当前固定值 8k:24；16k:32 */
    pshwPara[22] = 1;                              /*           非线性回声消除COH方法使能标志 */    pshwPara[23] = 1;                              /* INT16 Q0  COH人工回声增益次方施加 */	pshwPara[24] = 0;                              /*           非线性回声消除SER方法使能标志 */
    pshwPara[25] = 1;                              /* INT16 Q0  SER人工回声增益次方施加 */
    pshwPara[26] = 320;                            /* INT16 Q0  DTD判决处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[27] = 32;                             /* INT16 Q0  DTD判决子带个数；当前固定值 8k:24；16k:32 */
    pshwPara[28] = 200;                            /* INT16 Q0  PASS态判断：远端信号幅度阈值 */	pshwPara[29] = 5;                              /* INT16 Q0  PASS态判断：进入PASS态平滑帧数 */
    pshwPara[30] = 10;                             /* INT16 Q0  子带PASS态判断：子带能量阈值 */
    pshwPara[31] = 1;                              /*           使能标志：子带DTD的0,1判断 */	pshwPara[32] = 10;                              /* INT16 Q0  远端信号大于该阈值即做子带DTD的0,1判断 */	pshwPara[33] = 20;                             /* INT16 Q0  残差低于此阈值则做子带DTD的0判断 */	pshwPara[34] = (short int)(0.3f*(1<<15));      /* INT16 Q15 残差与近端能量比低于此阈值则做子带DTD的0判断 */	pshwPara[35] = 1;                              /* INT16 Q0  残差平滑DTD0,1判断时对非线性程度倍数扩充 1至5 */
    pshwPara[36] = 32;                             /* INT16 Q0  高于该子带号的子带实行高频子带强压制为0 */	pshwPara[37] = 5;                              /* INT16 Q0  实行高频压制远端能量阈值 */
    pshwPara[38] = 1;                              /* INT16 Q0  DTD整帧判决:使用子带起始索引 1-24 */	pshwPara[39] = 10;                              /* INT16 Q0  DTD整帧判决:使用子带终止索引 1-24 */	pshwPara[40] = 3;                              /* INT16 Q0  DTD整帧判决:高于Gain阈值子带数高于该值判DT */	pshwPara[41] = 3;                              /* INT16 Q0  DTD整帧判决:连续出现该值个数的ST才最终判为ST */	pshwPara[42] = (short int)(0.30f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值初始值 */	pshwPara[43] = (short int)(0.04f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值调整步长 */	pshwPara[44] = (short int)(0.40f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值最大值 */	pshwPara[45] = (short int)(0.25f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值最小值 */
    pshwPara[46] = (short int)(0.0313f*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号0 */
    pshwPara[47] = (short int)(0.0625*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号1 */
    pshwPara[48] = (short int)(0.0938*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号2 */
    pshwPara[49] = (short int)(0.1250*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号3 */
    pshwPara[50] = (short int)(0.1563*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号4 */
    pshwPara[51] = (short int)(0.1875*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号5 */
    pshwPara[52] = (short int)(0.2188*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号6 */
    pshwPara[53] = (short int)(0.2500*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号7 */
    pshwPara[54] = (short int)(0.2813*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号8 */
    pshwPara[55] = (short int)(0.3125*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号9 */
    pshwPara[56] = (short int)(0.3438*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号10 */
    pshwPara[57] = (short int)(0.3750*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号11 */
    pshwPara[58] = (short int)(0.4063*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号12 */
    pshwPara[59] = (short int)(0.4375*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号13 */
    pshwPara[60] = (short int)(0.4688*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号14 */
    pshwPara[61] = (short int)(0.5000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号15 */
    pshwPara[62] = (short int)(0.5313*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号16 */
    pshwPara[63] = (short int)(0.5625*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号17 */
    pshwPara[64] = (short int)(0.5938*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号18 */
    pshwPara[65] = (short int)(0.6250*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号19 */
    pshwPara[66] = (short int)(0.6563*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号20 */
    pshwPara[67] = (short int)(0.6875*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号21 */
    pshwPara[68] = (short int)(0.7188*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号22 */
    pshwPara[69] = (short int)(0.7500*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号23 */
    pshwPara[70] = (short int)(0.7813*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号24 */
    pshwPara[71] = (short int)(0.8125*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号25 */
    pshwPara[72] = (short int)(0.8438*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号26 */
    pshwPara[73] = (short int)(0.8750*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号27 */
    pshwPara[74] = (short int)(0.9063*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号28 */
    pshwPara[75] = (short int)(0.9375*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号29 */
    pshwPara[76] = (short int)(0.9688*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号30 */
    pshwPara[77] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号31 */

    /*------ 2.ANR 参数设置 ------*/
    pshwPara[90] = 1;                              /*           使能标志：上行噪声抑制使能 */
    pshwPara[91] = 16000;                          /* INT16 Q0  ANR采样率设置，当前固定值 8k,16k */
    pshwPara[92] = 320;                            /* INT16 Q0  ANR帧长设置，当前固定值 8k:160；16k:320 */
    pshwPara[93] = 32;                             /* INT16 Q0  ANR子带个数，当前固定值 8k:24；16k:32 */
    pshwPara[94] = 2;                              /* INT16 Q0  ANR噪声估计时间片，0到10 */
    pshwPara[110] = 0;                             /*           使能标志：下行噪声抑制使能 */
    pshwPara[111] = 16000;                         /* INT16 Q0  ANR采样率设置，当前固定值 8k,16k */
    pshwPara[112] = 320;                           /* INT16 Q0  ANR帧长设置，当前固定值 8k:160；16k:320 */
    pshwPara[113] = 32;                            /* INT16 Q0  ANR子带个数，当前固定值 8k:24；16k:32 */
    pshwPara[114] = 2;                            /* INT16 Q0  ANR噪声估计时间片，0到10 */

    /*------ 3.AGC 参数配置 ------*/
    pshwPara[130] = 1;                              /*           使能标志：上行AGC消除使能 */
    pshwPara[131] = 16000;                          /* INT16 Q0  采样率配置；当前固定值 8k,16k */
    pshwPara[132] = 320;                            /* INT16 Q0  处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[133] = (short int)(6.0f*(1<<5));       /* INT16 Q5  线性段提升dB数 */
    pshwPara[134] = (short int)(-55.0f*(1<<5));     /* INT16 Q5  扩张段起始能量dB阈值 */
    pshwPara[135] = (short int)(-46.0f*(1<<5));     /* INT16 Q5  线性段起始能量dB阈值 */
    pshwPara[136] = (short int)(-24.0f*(1<<5));     /* INT16 Q5  压缩段起始能量dB阈值 */	pshwPara[137] = (short int)(1.2f*(1<<12));      /* INT16 Q12 扩张段斜率 */
    pshwPara[138] = (short int)(0.8f*(1<<12));      /* INT16 Q12 线性段斜率 */
    pshwPara[139] = (short int)(0.4f*(1<<12));      /* INT16 Q12 压缩段斜率 */
    pshwPara[140] = 40;                            /* INT16 Q0  扩张段时域平滑点数 */
    pshwPara[141] = 80;                            /* INT16 Q0  线性段时域平滑点数 */
    pshwPara[142] = 80;                            /* INT16 Q0  压缩段时域平滑点数 */

    pshwPara[150] = 0;                             /*           使能标志：上行AGC消除使能 */
    pshwPara[151] = 16000;                         /* INT16 Q0  采样率配置；当前固定值 8k,16k */
    pshwPara[152] = 320;                           /* INT16 Q0  处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[153] = (short int)(6.0f*(1<<5));      /* INT16 Q5  线性段提升dB数 */
    pshwPara[154] = (short int)(-55.0f*(1<<5));    /* INT16 Q5  扩张段起始能量dB阈值 */
    pshwPara[155] = (short int)(-46.0f*(1<<5));    /* INT16 Q5  线性段起始能量dB阈值 */
    pshwPara[156] = (short int)(-24.0f*(1<<5));    /* INT16 Q5  压缩段起始能量dB阈值 */	pshwPara[157] = (short int)(1.2f*(1<<12));     /* INT16 Q12 扩张段斜率 */
    pshwPara[158] = (short int)(0.8f*(1<<12));     /* INT16 Q12 线性段斜率 */
    pshwPara[159] = (short int)(0.4f*(1<<12));     /* INT16 Q12 压缩段斜率 */
    pshwPara[160] = 40;                            /* INT16 Q0  扩张段时域平滑点数 */
    pshwPara[161] = 80;                            /* INT16 Q0  线性段时域平滑点数 */
    pshwPara[162] = 80;                            /* INT16 Q0  压缩段时域平滑点数 */

    /*------ 4.EQ 参数设置 ------*/
    pshwPara[170] = 0;                             /*           使能标志：上行EQ使能标志 */
    pshwPara[171] = 320;                           /* INT16 Q0  上行EQ处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[172] = 1;                             /* INT16 Q0  上行EQ滤波器长度 */
    pshwPara[173] = (short int)(1.0f*(1<<15));     /* INT16 Q15 上行EQ滤波器系数数组 */

    pshwPara[330] = 0;                             /*           使能标志：上行EQ使能标志 */
    pshwPara[331] = 320;                           /* INT16 Q0  上行EQ处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[332] = 1;                             /* INT16 Q0  上行EQ滤波器长度 */
    pshwPara[333] = (short int)(1.0f*(1<<15));     /* INT16 Q15 上行EQ滤波器系数数组 */

    /*------ 5.CNG 参数设置 ------*/
    pshwPara[490] = 1;                             /*           使能标志：CNG使能标志 */
    pshwPara[491] = 16000;                         /* INT16 Q0  CNG处理采样率；当前固定值 8k,16k */
    pshwPara[492] = 320;                           /* INT16 Q0  CNG处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[493] = 2;                             /* INT16 Q0 施加舒适噪声幅度比例 */
    pshwPara[494] = 10;                             /* INT16 Q0 白噪随机数生成幅度 */
    pshwPara[495] = (short int)(0.92f*(1<<15));    /* INT16 Q15 施加舒适噪声平滑度 */
    pshwPara[496] = (short int)(0.3f*(1<<15));     /* INT16 Q15 施加舒适噪声语音纹理模拟程度 */
#else
    /*------ 0.总模块参数设置 ------*/
    pshwPara[0] = 8000;                           /* INT16 Q0  采样率设置；当前仅支持8000,16000 */
    pshwPara[1] = 160;                             /* INT16 Q0  处理帧长设置；8k:160；16k:320 */

    /*------ 1.AEC 参数设置 ------*/
    pshwPara[10] = 1;                              /*           使能标志：回声消除使能 */
    pshwPara[11] = 160;                            /* INT16 Q0  处理帧长设置；8k:160；16k:320 */
    pshwPara[12] = 1;                              /* INT16 Q0  默认延时设置(单位样点数),0到3200 */
    pshwPara[13] = 0;                              /*           使能标志：延时估计使能 */
    pshwPara[14] = 80;                            /* INT16 Q0  延时估计处理帧长；8k:80；16k:160 */
    pshwPara[15] = 16;                             /* INT16 Q0  最大delay帧数设置，一帧10ms；当前固定值 */
    pshwPara[16] = 0;                              /* INT16 Q0  反向超前帧数，一帧10ms；当前固定值 0 */
    pshwPara[17] = 160;                            /* INT16 Q0  MDF处理帧长设置；当前固定值 8k:160；16k:320 */
    pshwPara[18] = 320;                            /* INT16 Q0  MDF拖尾长度设置，即滤波长度；当前固定值 8k:320；16k:640 */
    pshwPara[19] = 8000;                          /* INT16 Q0  MDF采样率设置；当前固定值 8k,16k */
    pshwPara[20] = 160;                            /* INT16 Q0  NLP处理帧长设置；当前固定值 8k:160；16k:320 */
    pshwPara[21] = 24;                             /* INT16 Q0  NLP处理子带设置；当前固定值 8k:24；16k:32 */
    pshwPara[22] = 1;                              /*           非线性回声消除COH方法使能标志 */
    pshwPara[23] = 1;                              /* INT16 Q0  COH人工回声增益次方施加 */
    pshwPara[24] = 0;                              /*           非线性回声消除SER方法使能标志 */
    pshwPara[25] = 1;                              /* INT16 Q0  SER人工回声增益次方施加 */
    pshwPara[26] = 160;                            /* INT16 Q0  DTD判决处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[27] = 24;                             /* INT16 Q0  DTD判决子带个数；当前固定值 8k:24；16k:32 */
    pshwPara[28] = 200;                            /* INT16 Q0  PASS态判断：远端信号幅度阈值 */
    pshwPara[29] = 5;                              /* INT16 Q0  PASS态判断：进入PASS态平滑帧数 */
    pshwPara[30] = 20;                             /* INT16 Q0  子带PASS态判断：子带能量阈值 */
    pshwPara[31] = 1;                              /*           使能标志：子带DTD的0,1判断 */
    pshwPara[32] = 0;                              /* INT16 Q0  远端信号大于该阈值即做子带DTD的0,1判断 */
    pshwPara[33] = 50;                             /* INT16 Q0  残差低于此阈值则做子带DTD的0判断 */
    pshwPara[34] = (short int)(0.1f*(1<<15));      /* INT16 Q15 残差与近端能量比低于此阈值则做子带DTD的0判断 */
    pshwPara[35] = 1;                              /* INT16 Q0  残差平滑DTD0,1判断时对非线性程度倍数扩充 1至5 */
    pshwPara[36] = 24;                             /* INT16 Q0  高于该子带号的子带实行高频子带强压制为0 */
    pshwPara[37] = 5;                              /* INT16 Q0  实行高频压制远端能量阈值 */
    pshwPara[38] = 1;                              /* INT16 Q0  DTD整帧判决:使用子带起始索引 1-24 */
    pshwPara[39] = 5;                              /* INT16 Q0  DTD整帧判决:使用子带终止索引 1-24 */
    pshwPara[40] = 1;                              /* INT16 Q0  DTD整帧判决:高于Gain阈值子带数高于该值判DT */
    pshwPara[41] = 3;                              /* INT16 Q0  DTD整帧判决:连续出现该值个数的ST才最终判为ST */
    pshwPara[42] = (short int)(0.05f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值初始值 */
    pshwPara[43] = (short int)(0.05f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值调整步长 */
    pshwPara[44] = (short int)(0.05f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值最大值 */
    pshwPara[45] = (short int)(0.05f*(1<<15));     /* INT16 Q15 DTD整帧判决:Gain阈值最小值 */
    pshwPara[46] = (short int)(0.0417*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号0 */
    pshwPara[47] = (short int)(0.0833*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号1 */
    pshwPara[48] = (short int)(0.1250*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号2 */
    pshwPara[49] = (short int)(0.1667*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号3 */
    pshwPara[50] = (short int)(0.2083*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号4 */
    pshwPara[51] = (short int)(0.2500*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号5 */
    pshwPara[52] = (short int)(0.2917*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号6 */
    pshwPara[53] = (short int)(0.3333*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号7 */
    pshwPara[54] = (short int)(0.3750*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号8 */
    pshwPara[55] = (short int)(0.4167*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号9 */
    pshwPara[56] = (short int)(0.4583*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号10 */
    pshwPara[57] = (short int)(0.5000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号11 */
    pshwPara[58] = (short int)(0.5417*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号12 */
    pshwPara[59] = (short int)(0.5833*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号13 */
    pshwPara[60] = (short int)(0.6250*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号14 */
    pshwPara[61] = (short int)(0.6667*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号15 */
    pshwPara[62] = (short int)(0.7083*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号16 */
    pshwPara[63] = (short int)(0.7500*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号17 */
    pshwPara[64] = (short int)(0.7917*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号18 */
    pshwPara[65] = (short int)(0.8333*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号19 */
    pshwPara[66] = (short int)(0.8750*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号20 */
    pshwPara[67] = (short int)(0.9167*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号21 */
    pshwPara[68] = (short int)(0.9583*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号22 */
    pshwPara[69] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号23 */
    pshwPara[70] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号24 */
    pshwPara[71] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号25 */
    pshwPara[72] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号26 */
    pshwPara[73] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号27 */
    pshwPara[74] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号28 */
    pshwPara[75] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号29 */
    pshwPara[76] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号30 */
    pshwPara[77] = (short int)(1.0000*(1<<15));     /* INT16 Q15 子带非线性程度配置，子带号31 */

    /*------ 2.ANR 参数设置 ------*/
    pshwPara[90] = 1;                              /*           使能标志：上行噪声抑制使能 */
    pshwPara[91] = 8000;                          /* INT16 Q0  ANR采样率设置，当前固定值 8k,16k */
    pshwPara[92] = 160;                            /* INT16 Q0  ANR帧长设置，当前固定值 8k:160；16k:320 */
    pshwPara[93] = 24;                             /* INT16 Q0  ANR子带个数，当前固定值 8k:24；16k:32 */
    pshwPara[94] = 5;                             /* INT16 Q0  ANR噪声估计时间片，0到10 */

    pshwPara[110] = 0;                             /*           使能标志：下行噪声抑制使能 */
    pshwPara[111] = 8000;                         /* INT16 Q0  ANR采样率设置，当前固定值 8k,16k */
    pshwPara[112] = 160;                           /* INT16 Q0  ANR帧长设置，当前固定值 8k:160；16k:320 */
    pshwPara[113] = 24;                            /* INT16 Q0  ANR子带个数，当前固定值 8k:24；16k:32 */
    pshwPara[114] = 5;                            /* INT16 Q0  ANR噪声估计时间片，0到10 */

    /*------ 3.AGC 参数配置 ------*/
    pshwPara[130] = 1;                              /*           使能标志：上行AGC消除使能 */
    pshwPara[131] = 8000;                          /* INT16 Q0  采样率配置；当前固定值 8k,16k */
    pshwPara[132] = 160;                            /* INT16 Q0  处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[133] = (short int)(6.0f*(1<<5));       /* INT16 Q5  线性段提升dB数 */
    pshwPara[134] = (short int)(-55.0f*(1<<5));     /* INT16 Q5  扩张段起始能量dB阈值 */
    pshwPara[135] = (short int)(-46.0f*(1<<5));     /* INT16 Q5  线性段起始能量dB阈值 */
    pshwPara[136] = (short int)(-24.0f*(1<<5));     /* INT16 Q5  压缩段起始能量dB阈值 */
    pshwPara[137] = (short int)(1.2f*(1<<12));      /* INT16 Q12 扩张段斜率 */
    pshwPara[138] = (short int)(0.8f*(1<<12));      /* INT16 Q12 线性段斜率 */
    pshwPara[139] = (short int)(0.4f*(1<<12));      /* INT16 Q12 压缩段斜率 */
    pshwPara[140] = 20;                            /* INT16 Q0  扩张段时域平滑点数 */
    pshwPara[141] = 40;                            /* INT16 Q0  线性段时域平滑点数 */
    pshwPara[142] = 40;                            /* INT16 Q0  压缩段时域平滑点数 */

    pshwPara[150] = 0;                             /*           使能标志：上行AGC消除使能 */
    pshwPara[151] = 8000;                         /* INT16 Q0  采样率配置；当前固定值 8k,16k */
    pshwPara[152] = 160;                           /* INT16 Q0  处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[153] = (short int)(6.0f*(1<<5));      /* INT16 Q5  线性段提升dB数 */
    pshwPara[154] = (short int)(-55.0f*(1<<5));    /* INT16 Q5  扩张段起始能量dB阈值 */
    pshwPara[155] = (short int)(-46.0f*(1<<5));    /* INT16 Q5  线性段起始能量dB阈值 */
    pshwPara[156] = (short int)(-24.0f*(1<<5));    /* INT16 Q5  压缩段起始能量dB阈值 */
    pshwPara[157] = (short int)(1.2f*(1<<12));     /* INT16 Q12 扩张段斜率 */
    pshwPara[158] = (short int)(0.8f*(1<<12));     /* INT16 Q12 线性段斜率 */
    pshwPara[159] = (short int)(0.2f*(1<<12));     /* INT16 Q12 压缩段斜率 */
    pshwPara[160] = 20;                            /* INT16 Q0  扩张段时域平滑点数 */
    pshwPara[161] = 40;                            /* INT16 Q0  线性段时域平滑点数 */
    pshwPara[162] = 40;                            /* INT16 Q0  压缩段时域平滑点数 */

    /*------ 4.EQ 参数设置 ------*/
    pshwPara[170] = 0;                             /*           使能标志：上行EQ使能标志 */
    pshwPara[171] = 160;                           /* INT16 Q0  上行EQ处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[172] = 1;                             /* INT16 Q0  上行EQ滤波器长度 */
    pshwPara[173] = (short int)(1.0f*(1<<15));     /* INT16 Q15 上行EQ滤波器系数数组 */

    pshwPara[330] = 0;                             /*           使能标志：上行EQ使能标志 */
    pshwPara[331] = 160;                           /* INT16 Q0  上行EQ处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[332] = 1;                             /* INT16 Q0  上行EQ滤波器长度 */
    pshwPara[333] = (short int)(1.0f*(1<<15));     /* INT16 Q15 上行EQ滤波器系数数组 */

    /*------ 5.CNG 参数设置 ------*/
    pshwPara[490] = 1;                             /*           使能标志：CNG使能标志 */
    pshwPara[491] = 8000;                         /* INT16 Q0  CNG处理采样率；当前固定值 8k,16k */
    pshwPara[492] = 160;                           /* INT16 Q0  CNG处理帧长；当前固定值 8k:160；16k:320 */
    pshwPara[493] = 2;                             /* INT16 Q0 施加舒适噪声幅度比例 */
    pshwPara[494] = 10;                             /* INT16 Q0 白噪随机数生成幅度 */
    pshwPara[495] = (short int)(0.92f*(1<<15));    /* INT16 Q15 施加舒适噪声平滑度 */
    pshwPara[496] = (short int)(0.3f*(1<<15));     /* INT16 Q15 施加舒适噪声语音纹理模拟程度 */
#endif
}


