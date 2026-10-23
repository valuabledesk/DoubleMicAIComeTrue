#define AUDIO_ALGO
#define USE_JSON
//#define FILTER_ENABLE
//#define FREQ_AGC_ENABLE
//#define DIGITAL_GAIN_ENABLE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <pthread.h>

#include "mi_sys.h"
#include "mi_ai.h"
#include "mi_ao.h"

#ifndef COLOR_NONE
#define COLOR_NONE "\033[0m"
#endif

#ifndef COLOR_GREEN
#define COLOR_GREEN "\033[0;32m"
#endif

#ifndef COLOR_RED
#define COLOR_RED "\033[0;31m"
#endif

#ifndef COLOR_YELLOW
#define COLOR_YELLOW "\033[1;33m"
#endif

#ifndef ST_NOP
#define ST_NOP(fmt, args...)
#endif

#ifndef ST_INFO
#define ST_INFO(fmt, args...)                                \
    do                                                       \
    {                                                        \
        printf("[INFO]:%s[%d]: \n", __FUNCTION__, __LINE__); \
        printf(fmt, ##args);                                 \
    } while (0)
#endif

#ifndef ST_DBG
#define ST_DBG(fmt, args...)                                                     \
    do                                                                           \
    {                                                                            \
        printf(COLOR_GREEN "[DBG]:%s[%d]: " COLOR_NONE, __FUNCTION__, __LINE__); \
        printf(fmt, ##args);                                                     \
    } while (0)
#endif

#ifndef ST_WARN
#define ST_WARN(fmt, args...)                                                      \
    do                                                                             \
    {                                                                              \
        printf(COLOR_YELLOW "[WARN]:%s[%d]: " COLOR_NONE, __FUNCTION__, __LINE__); \
        printf(fmt, ##args);                                                       \
    } while (0)
#endif

#ifndef ST_ERR
#define ST_ERR(fmt, args...)                                                   \
    do                                                                         \
    {                                                                          \
        printf(COLOR_RED "[ERR]:%s[%d]: " COLOR_NONE, __FUNCTION__, __LINE__); \
        printf(fmt, ##args);                                                   \
    } while (0)
#endif

#ifndef STCHECKRESULT
#define STCHECKRESULT(_func_)                                                              \
    do                                                                                     \
    {                                                                                      \
        MI_S32 s32Ret = MI_SUCCESS;                                                        \
        s32Ret        = _func_;                                                            \
        if (s32Ret != MI_SUCCESS)                                                          \
        {                                                                                  \
            printf("[%s %d]exec function failed, error:%x\n", __func__, __LINE__, s32Ret); \
            return s32Ret;                                                                 \
        }                                                                                  \
        else                                                                               \
        {                                                                                  \
            printf("(%s %d)exec function pass.\n", __FUNCTION__, __LINE__);                \
        }                                                                                  \
    } while (0)
#endif

#ifndef THREAD_SLEEP_TIME_US
#define THREAD_SLEEP_TIME_US 10 * 1000
#endif

static const char *g_pDumpDirPath = NULL;

static MI_BOOL g_bAecAoInWithPcm = FALSE;
static MI_BOOL g_bAecAiInWithPcm = FALSE;

#define AO_GRP_CHN_NUM_MAX 2
#define AO_PERIOD_SIZE 640
#define AO_PLAY_UNIT_SIZE 2560

static MI_AUDIO_SampleRate_e g_enAoSampleRate = E_MI_AUDIO_SAMPLE_RATE_16000;
static MI_AUDIO_SoundMode_e g_enAoSoundMode = E_MI_AUDIO_SOUND_MODE_MONO;
static MI_AO_ChannelMode_e g_enAoChannelMode = E_MI_AO_CHANNEL_MODE_DOUBLE_MONO;
static MI_AO_If_e g_enAoIfs[] = {E_MI_AO_IF_DAC_AB, E_MI_AO_IF_ECHO_A};
static MI_S8 g_s16AoVolume[AO_GRP_CHN_NUM_MAX] = {-2, -2};
static pthread_t g_stAoPlayBufPt;
const char *g_pAoPlayPath = NULL;

#define AI_GRP_CHN_NUM_MAX 2
#define AI_PERIOD_SIZE 640
#define AI_ALGO_DATA_SIZE 128
#define AI_ALGO_ROUND_SIZE (AI_ALGO_DATA_SIZE * E_MI_AUDIO_SOUND_MODE_MONO * 16 / 8)
#define AI_ALGO_ROUND_CNT (AI_PERIOD_SIZE / AI_ALGO_DATA_SIZE)

static MI_AUDIO_SampleRate_e g_enAiSampleRate = E_MI_AUDIO_SAMPLE_RATE_16000;
static MI_AUDIO_SoundMode_e g_enAiSoundMode = E_MI_AUDIO_SOUND_MODE_MONO;
static MI_AI_If_e g_enAiIfs[] = {E_MI_AI_IF_ADC_AB, E_MI_AI_IF_ECHO_A};
static MI_S16 g_s16AiIfGain[AI_GRP_CHN_NUM_MAX] = {10, 2};
static MI_S16 g_s16AiGain[AI_GRP_CHN_NUM_MAX] = {-1, -1};
static MI_S16 g_s16AiEchoGain[] = {0};
static MI_BOOL g_bAiGrpChnEnable[AI_GRP_CHN_NUM_MAX] = {FALSE, FALSE};
static MI_BOOL g_bAiHwAecEnable = FALSE;
static pthread_t g_stAiGetBufPt[AI_GRP_CHN_NUM_MAX];

#ifdef AUDIO_ALGO
#include "AudioAecProcess.h"
#include "AudioProcess.h"

//#define dump_aec_ao_in
//#define dump_aec_ai_in
//#define dump_aec_out
//#define dump_apc_in
//#define dump_apc_out

static MI_BOOL g_bEnableAec = TRUE;
static MI_BOOL g_bEnableApc = TRUE;
#ifdef USE_JSON
static MI_BOOL g_bEnableAECParamJson = TRUE;
static MI_BOOL g_bEnableAPCParamJson = TRUE;
static MI_BOOL g_bEnableAPCInternalJson = FALSE;
static char *g_aec_param_json_buff = NULL;
static char *g_apc_param_json_buff = NULL;
static char *g_apc_internal_json_buff = NULL;
#endif

static AEC_HANDLE g_aec_handle[AI_GRP_CHN_NUM_MAX] = {NULL};
static APC_HANDLE g_apc_handle[AI_GRP_CHN_NUM_MAX] = {NULL};
static char *g_aec_working_buffer_address[AI_GRP_CHN_NUM_MAX] = {NULL};
static char *g_apc_working_buffer_address[AI_GRP_CHN_NUM_MAX] = {NULL};
#ifdef DIGITAL_GAIN_ENABLE
static AudioApcOption g_apc_option = {{0, 0}};
#endif
#endif

typedef struct ST_Audio_InputParam_s
{
    MI_U8 u8Case;
} ST_Audio_InputParam_t;

static MI_BOOL g_bExit = FALSE;
static ST_Audio_InputParam_t g_stAudioInputParam;

static void ST_Flush(void)
{
	char c;
	while ((c = getchar()) != '\n' && c != EOF);
}

static void ST_Audio_Usage()
{
    printf("Usage:\n");
    printf("\techo 43 > /sys/class/gpio/export\n");
    printf("\techo out > /sys/class/gpio/gpio43/direction\n");
    printf("\techo 0 > /sys/class/gpio/gpio43/value\n");
    printf("\texport AUDIO_DUMP_PATH=./dump\n");
    printf("\texport AUDIO_AEC_DUMP=1\n");
    printf("\texport AUDIO_APC_DUMP=1\n");
    printf("\texport AUDIO_ANR_DUMP=1\n");
	printf("\texport AUDIO_EQ_DUMP=1\n");
    printf("\texport AUDIO_AGC_DUMP=1\n");
    printf("\t./prog_audio_audio_all 0 [ao_play.pcm] [dump]: Case 0: Open AEC\n");
    printf("\tmv ./dump/Audio_AEC_far_end_data_0.pcm ./dump/ai_chn0_aec_ao_in_debug.pcm\n");
    printf("\tmv ./dump/Audio_AEC_near_end_data_0.pcm ./dump/ai_chn0_aec_ai_in_debug.pcm\n");
    printf("\t./prog_audio_audio_all 1 \"\" [dump]: Case 1: Open AEC\n");
    printf("\tmv ./dump/Audio_AEC_far_end_data_0.pcm ./dump/ai_chn0_aec_ao_in_debug.pcm\n");
    printf("\t./prog_audio_audio_all 2 \"\" [dump]: Case 2: Open AEC\n");
    printf("\tmv ./dump/Audio_AEC_near_end_data_0.pcm ./dump/ai_chn0_aec_ai_in_debug.pcm\n");
    printf("\t./prog_audio_audio_all 3 [ao_play.pcm] [dump]: Case 3: Open AEC\n");
	printf("\t./prog_audio_audio_all 4 [ao_play.pcm] [dump]: Case 4: Close AEC\n");
	printf("\tmv ./dump/Audio_APC_input_data_0.pcm ./dump/ai_chn0_aec_ai_in_debug.pcm\n");
	printf("\t./prog_audio_audio_all 5 [ao_play.pcm] [dump]: Case 5: Close AEC\n");
}

static MI_S32 ST_Audio_GetInputParam(int argc, char **argv)
{
	const char path[] = "dump";
	int i = 0;
    MI_S32 s32Ret = MI_SUCCESS;

	for(i = 0; i < argc; i++)
	{
		if (strcmp(argv[i], "") == 0)
		{
			argv[i] = NULL;
		}
	}
	for (i = argc; i < 4; i++)
	{
		argv[i] = NULL;
	}

    g_stAudioInputParam.u8Case = atoi(argv[1]);
    g_pAoPlayPath = argv[2];
	g_pDumpDirPath = argv[3];
	if (g_pDumpDirPath == NULL)
	{
		g_pDumpDirPath = path;
	}

    return s32Ret;
}

static MI_S32 ST_SYS_Init()
{
    MI_SYS_Version_t stVersion;
    struct timeval tp;
    MI_U64 u64Pts = 0;
    MI_S32 s32Ret = MI_SUCCESS;

    STCHECKRESULT(MI_SYS_Init(0));
    STCHECKRESULT(MI_SYS_GetVersion(0, &stVersion));
    ST_INFO("stVersion.u8Version:%s\n", stVersion.u8Version);
    gettimeofday(&tp, NULL);
    u64Pts = (tp.tv_sec) * 1000000ULL + tp.tv_usec;
    STCHECKRESULT(MI_SYS_InitPtsBase(0, u64Pts));
    gettimeofday(&tp, NULL);
    u64Pts = (tp.tv_sec) * 1000000ULL + tp.tv_usec;
    STCHECKRESULT(MI_SYS_SyncPts(0, u64Pts));
    STCHECKRESULT(MI_SYS_GetCurPts(0, &u64Pts));
    printf("%s:%d u64Pts:0x%llx(%ds,%dus)\n",
        __func__, __LINE__, u64Pts, (int)tp.tv_sec, (int)tp.tv_usec);

    return s32Ret;
}

static MI_S32 ST_SYS_Exit()
{
    MI_S32 s32Ret = MI_SUCCESS;

    STCHECKRESULT(MI_SYS_Exit(0));

    return s32Ret;
}

#ifdef AUDIO_ALGO
static MI_S32 ST_AEC_Init()
{
#ifdef USE_JSON
	char aec_param_json_path[1024] = {0};
	int aec_param_json_buff_size = 0;
#endif
    MI_U8 u8ChnGrpIdx = 0;
    AudioAecInit aec_init;
    int buffer_size = 0;
    unsigned int suppression_mode_freq[6] = {20, 40, 60, 80, 100, 120};  
    unsigned int suppression_mode_intensity[7] = {15, 15, 15, 15, 15, 15, 15}; 
    AudioAecConfig aec_config;
	AudioAecOption aec_option;

#ifdef USE_JSON
	if (g_bEnableAECParamJson)
	{
		sprintf(aec_param_json_path, "%s/%s", g_pDumpDirPath, "AecParamJson.json");
		aec_param_json_buff_size = IaaAec_GetJsonFileSize(aec_param_json_path);
		g_aec_param_json_buff = (char *)malloc(aec_param_json_buff_size);
		if (g_aec_param_json_buff == NULL)
		{
			ST_ERR("malloc error\n");
			return -1;
		}
	}
#endif

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (g_bAiGrpChnEnable[u8ChnGrpIdx] == FALSE)
        {
            continue;
        }
        
        buffer_size = IaaAec_GetBufferSize();
        g_aec_working_buffer_address[u8ChnGrpIdx] = (char *)malloc(buffer_size);
        if (g_aec_working_buffer_address[u8ChnGrpIdx] == NULL)
        {
            ST_ERR("malloc error\n");
    		return -1;
        }

        memset(&aec_init, 0x00, sizeof(AudioAecInit));
        aec_init.farend_channel = (MI_U32)g_enAoSoundMode;
		if (g_bAiHwAecEnable)
		{
			aec_init.nearend_channel = (MI_U32)g_enAiSoundMode - 1;
		}
		else
		{
        	aec_init.nearend_channel = (MI_U32)g_enAiSoundMode;
		}
        aec_init.point_number = AI_ALGO_DATA_SIZE;
        aec_init.sample_rate = (IAA_AEC_SAMPLE_RATE)g_enAiSampleRate;
#ifdef USE_JSON
		if (g_bEnableAECParamJson)
		{
			STCHECKRESULT(IaaAec_InitReadFromJson(&aec_init, g_aec_param_json_buff, aec_param_json_path, aec_param_json_buff_size));
		}
#endif
        g_aec_handle[u8ChnGrpIdx] = IaaAec_Init(g_aec_working_buffer_address[u8ChnGrpIdx], &aec_init);
        if (g_aec_handle[u8ChnGrpIdx] == NULL)
    	{
    		ST_ERR("AEC init error\n");
    		return -1;
    	}
    	else
    	{
    		ST_INFO("AEC init succeed\n");
    	}

        memset(&aec_config, 0x00, sizeof(AudioAecConfig));
        aec_config.comfort_noise_enable = IAA_AEC_FALSE;
        aec_config.delay_sample = 0;
        memcpy(aec_config.suppression_mode_freq, suppression_mode_freq, sizeof(suppression_mode_freq));  
        memcpy(aec_config.suppression_mode_intensity, suppression_mode_intensity, sizeof(suppression_mode_intensity));
#ifdef USE_JSON
		if (g_bEnableAECParamJson)
		{
			STCHECKRESULT(IaaAec_ConfigReadFromJson(&aec_config, g_aec_param_json_buff, aec_param_json_path, aec_param_json_buff_size));
		}
#endif
        if (IaaAec_Config(g_aec_handle[u8ChnGrpIdx], &aec_config) == -1)
        {
            ST_ERR("config error\n");
            return -1;
        }

		memset(&aec_option, 0x00, sizeof(AudioAecOption));
		aec_option.recursive_ratio = 1;
		aec_option.block_num = 8;
		aec_option.mode = 0;
#ifdef USE_JSON
		if (g_bEnableAECParamJson)
		{
			STCHECKRESULT(IaaAec_OptionReadFromJson(&aec_option, g_aec_param_json_buff, aec_param_json_path, aec_param_json_buff_size));
		}
#endif
		STCHECKRESULT(IaaAec_SetRecursiveRatio(g_aec_handle[u8ChnGrpIdx], aec_option.recursive_ratio));
		STCHECKRESULT(IaaAec_SetADFBlockNum(g_aec_handle[u8ChnGrpIdx], aec_option.block_num));
		STCHECKRESULT(IaaAec_SetMode(g_aec_handle[u8ChnGrpIdx], aec_option.mode));
    }
    
    return MI_SUCCESS;
}

static MI_S32 ST_AEC_Exit()
{
    MI_U8 u8ChnGrpIdx = 0;

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (g_bAiGrpChnEnable[u8ChnGrpIdx] == FALSE)
        {
            continue;
        }
        
        if (g_aec_handle[u8ChnGrpIdx] != NULL)
        {
            IaaAec_Free(g_aec_handle[u8ChnGrpIdx]);
            g_aec_handle[u8ChnGrpIdx] = NULL;
        }
        
        if (g_aec_working_buffer_address[u8ChnGrpIdx] != NULL)
        {
            free(g_aec_working_buffer_address[u8ChnGrpIdx]);
            g_aec_working_buffer_address[u8ChnGrpIdx] = NULL;
        }
    }

#ifdef USE_JSON
	if (g_bEnableAECParamJson)
	{
		if (g_aec_param_json_buff != NULL)
        {
            free(g_aec_param_json_buff);
            g_aec_param_json_buff = NULL;
        }
	}
#endif
    
    return MI_SUCCESS;
}

static MI_S32 ST_APC_Init()
{
#ifdef USE_JSON
	char apc_param_json_path[1024] = {0};
	int apc_param_json_buff_size = 0;
	char apc_internal_json_path[1024] = {0};
	int apc_internal_json_buff_size = 0;
#endif
    MI_U8 u8ChnGrpIdx = 0;
    AudioApcBufferConfig apc_switch;
    int buffer_size = 0;
    AudioProcessInit audio_process_init;
    int intensity_band[6] = {6, 11, 16, 64, 80, 128};
	int intensity[7] = {30, 30, 30, 30, 30, 30, 30};
    short eq_table[_EQ_BAND_NUM] = {
		-20, -12, -6, -6, -4, -3, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, -3, -3, -3, -3, -3, -3, -3,
		-3, -3, -3, -3, -3, -3, -3, -3, -3, -3,
		-6, -6, -6, -6, -6, -6, -6, -6, -6, -6,
		-6, -6, -6, -6, -6, -6, -6, -6, -6, -6,
		-12, -12, -12, -12, -12, -12, -12, -12, -12, -12,
		-12, -12, -12, -12, -12, -12, -12, -12, -12};
    short compression_ratio_input[_AGC_CR_NUM] = {-80, -70, -40, -30, -20, -12, 0};
	short compression_ratio_output[_AGC_CR_NUM] = {-75, -60, -30, -20, -15, -9, -3};
#ifdef FILTER_ENABLE
	float frequency_response[512] = {0};
	AudioFilterConfig filter_config1;
	AudioFilterConfig filter_config2;
#endif
#ifdef FREQ_AGC_ENABLE
    int freqBand[_AGC_FREQ_BAND_NUM] = {3000, 6000, 8000};
    int compressionRatioArrayLowInput[_AGC_CR_NUM] = {-65, -55, -48, -25, -18, -12, 0};
	int compressionRatioArrayLowOutput[_AGC_CR_NUM] = {-50, -45, -35, -20, -15, -9, -3};
	int compressionRatioArrayMidInput[_AGC_CR_NUM] = {-65, -55, -48, -25, -18, -12, 0};
	int compressionRatioArrayMidOutput[_AGC_CR_NUM] = {-50, -45, -35, -20, -15, -9, -3};
	int compressionRatioArrayHighInput[_AGC_CR_NUM] = {-65, -55, -48, -25, -18, -12, 0};
	int compressionRatioArrayHighOutput[_AGC_CR_NUM] = {-50, -45, -35, -20, -15, -9, -3};
#endif
#ifdef DIGITAL_GAIN_ENABLE
	AudioApcOption apc_option = {{0, 0}};
#endif
    AudioAnrConfig anr_config;
    AudioEqConfig eq_config;
    AudioHpfConfig hpf_config;
    AudioAgcConfig agc_config;

#ifdef USE_JSON
	if (g_bEnableAPCParamJson)
	{
		sprintf(apc_param_json_path, "%s/%s", g_pDumpDirPath, "ApcParamJson.json");
		apc_param_json_buff_size = IaaApc_GetJsonFileSize(apc_param_json_path);
		g_apc_param_json_buff = (char *)malloc(apc_param_json_buff_size);
		if (g_apc_param_json_buff == NULL)
        {
            ST_ERR("malloc error\n");
    		return -1;
        }
	}
	if (g_bEnableAPCInternalJson)
	{
		sprintf(apc_internal_json_path, "%s/%s", g_pDumpDirPath, "ApcInternalJson.json");
		apc_internal_json_buff_size = IaaApc_GetJsonFileSize(apc_internal_json_path);
		g_apc_internal_json_buff = (char *)malloc(apc_internal_json_buff_size);
		if (g_apc_internal_json_buff == NULL)
        {
            ST_ERR("malloc error\n");
    		return -1;
        }
	}
#endif

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (g_bAiGrpChnEnable[u8ChnGrpIdx] == FALSE)
        {
            continue;
        }

        memset(&apc_switch, 0x00, sizeof(AudioApcBufferConfig));
        apc_switch.anr_enable = 1;
        apc_switch.eq_enable = 1;
        apc_switch.dr_enable = 0;
        apc_switch.vad_enable = 0;
        apc_switch.agc_enable = 1;
#ifdef USE_JSON
		if (g_bEnableAPCParamJson)
		{
			STCHECKRESULT(IaaApc_SwitchReadFromJson(&apc_switch, g_apc_param_json_buff, apc_param_json_path, apc_param_json_buff_size));
		}
#endif
        buffer_size = IaaApc_GetBufferSize(&apc_switch);
		
        g_apc_working_buffer_address[u8ChnGrpIdx] = (char *)malloc(buffer_size);
        if (g_apc_working_buffer_address[u8ChnGrpIdx] == NULL)
        {
            ST_ERR("malloc error\n");
    		return -1;
        }
        memset(&audio_process_init, 0x00, sizeof(AudioProcessInit));
        audio_process_init.point_number = AI_ALGO_DATA_SIZE;
		if (g_bAiHwAecEnable)
		{
			audio_process_init.channel = (MI_U32)g_enAiSoundMode - 1;
		}
		else
		{
        	audio_process_init.channel = (MI_U32)g_enAiSoundMode;
		}
        audio_process_init.sample_rate = (IAA_APC_SAMPLE_RATE)g_enAiSampleRate;
#ifdef USE_JSON
		if (g_bEnableAPCParamJson)
		{
			STCHECKRESULT(IaaApc_InitReadFromJson(&audio_process_init, g_apc_param_json_buff, apc_param_json_path, apc_param_json_buff_size));
		}
#endif
        g_apc_handle[u8ChnGrpIdx] = IaaApc_Init((char * const)g_apc_working_buffer_address[u8ChnGrpIdx], &audio_process_init, &apc_switch);
        if (g_apc_handle[u8ChnGrpIdx] == NULL)
    	{
    		ST_ERR("APC init error\n");
    		return -1;
    	}
    	else
    	{
    		ST_INFO("APC init succeed\n");
    	}

    	/******ANR Config*******/
        memset(&anr_config, 0x00, sizeof(AudioAnrConfig));
    	anr_config.anr_enable = apc_switch.anr_enable;
    	anr_config.user_mode = 1;
    	anr_config.anr_filter_mode = 0;
    	memcpy(anr_config.anr_intensity_band, intensity_band, 6 * sizeof(int));
    	memcpy(anr_config.anr_intensity, intensity, 7 * sizeof(int));
    	anr_config.anr_smooth_level = 5;
    	anr_config.anr_converge_speed = NR_SPEED_HIGH;
    	/******EQ Config********/
        memset(&eq_config, 0x00, sizeof(AudioEqConfig));
    	eq_config.eq_enable =apc_switch.eq_enable;
    	eq_config.user_mode = 1;
    	memcpy(eq_config.eq_gain_db, eq_table, _EQ_BAND_NUM * sizeof(short));
    	/******HPF Config********/
        memset(&hpf_config, 0x00, sizeof(AudioHpfConfig));
    	hpf_config.hpf_enable = apc_switch.eq_enable;
    	hpf_config.user_mode = 1;
    	hpf_config.cutoff_frequency = AUDIO_HPF_FREQ_120;
    	/******AGC Config********/
        memset(&agc_config, 0x00, sizeof(AudioAgcConfig));
    	agc_config.agc_enable = apc_switch.agc_enable;
    	agc_config.user_mode = 1;
    	agc_config.gain_info.gain_max = 20;
    	agc_config.gain_info.gain_min = -20;
    	agc_config.gain_info.gain_init = 10;
    	agc_config.drop_gain_max = 30;
    	agc_config.gain_step = 1;
    	agc_config.attack_time = 1;
    	agc_config.release_time = 1;
    	agc_config.noise_gate_db = -75;
    	memcpy(agc_config.compression_ratio_input, compression_ratio_input, _AGC_CR_NUM * sizeof(short));
    	memcpy(agc_config.compression_ratio_output, compression_ratio_output, _AGC_CR_NUM * sizeof(short));
    	agc_config.noise_gate_attenuation_db = 0;
    	agc_config.drop_gain_threshold = -3;
#ifdef USE_JSON
		if (g_bEnableAPCParamJson)
		{
			STCHECKRESULT(IaaApc_ConfigReadFromJson(&anr_config, &eq_config, &hpf_config, &agc_config, g_apc_param_json_buff, apc_param_json_path, apc_param_json_buff_size));
		}
#endif
        if (IaaApc_Config(g_apc_handle[u8ChnGrpIdx], &anr_config, &eq_config, &hpf_config, NULL, NULL, &agc_config) == -1)
        {
            ST_ERR("config error\n");
            return -1;
        }
#ifdef USE_JSON
		if (g_bEnableAPCInternalJson)
		{
			STCHECKRESULT(IaaApc_ReadJson(g_apc_handle[u8ChnGrpIdx], g_apc_internal_json_buff, apc_internal_json_path, apc_internal_json_buff_size));
		}
#endif

#ifdef FILTER_ENABLE
		memset(&filter_config1, 0x00, sizeof(AudioFilterConfig));
		filter_config1.q_factor = 5;
		filter_config1.f0 = 500;
		filter_config1.type = EQ_NOTCH_FILTER;
		filter_config1.gain = -10;
		STCHECKRESULT(IaaApc_FilterDesign(g_apc_handle[u8ChnGrpIdx], 1, &filter_config1));
		memset(&filter_config2, 0x00, sizeof(AudioFilterConfig));
		filter_config2.q_factor = 5;
		filter_config2.f0 = 1000;
		filter_config2.type = EQ_NOTCH_FILTER;
		filter_config2.gain = -10;
		STCHECKRESULT(IaaApc_FilterDesign(g_apc_handle[u8ChnGrpIdx], 2, &filter_config2));
#ifdef USE_JSON
		if (g_bEnableAPCParamJson)
		{
			STCHECKRESULT(IaaApc_FilterDesignReadFromJson(g_apc_handle[u8ChnGrpIdx], g_apc_param_json_buff, apc_param_json_path, apc_param_json_buff_size));
		}
#endif
		IaaApc_FilterFreqz(g_apc_handle[u8ChnGrpIdx], frequency_response);
#endif

#ifdef FREQ_AGC_ENABLE
		if (agc_config.user_mode == 2)
		{
#ifdef USE_JSON
			if (g_bEnableAPCParamJson)
			{
				STCHECKRESULT(IaaApc_SetAgcReadFromJson(&freqBand[0], \
					&compressionRatioArrayLowInput[0], &compressionRatioArrayLowOutput[0], \
					&compressionRatioArrayMidInput[0], &compressionRatioArrayMidOutput[0], \
					&compressionRatioArrayHighInput[0], &compressionRatioArrayHighOutput[0], \
					g_apc_param_json_buff, apc_param_json_path, apc_param_json_buff_size));
			}
#endif
			STCHECKRESULT(IaaApc_SetAgcFreqBand(g_apc_handle[u8ChnGrpIdx], freqBand));
			STCHECKRESULT(IaaApc_SetLowFreqCompressionRatioCurve(g_apc_handle[u8ChnGrpIdx], compressionRatioArrayLowInput, compressionRatioArrayLowOutput));
			STCHECKRESULT(IaaApc_SetMidFreqCompressionRatioCurve(g_apc_handle[u8ChnGrpIdx], compressionRatioArrayMidInput, compressionRatioArrayMidOutput));
			STCHECKRESULT(IaaApc_SetHighFreqCompressionRatioCurve(g_apc_handle[u8ChnGrpIdx], compressionRatioArrayHighInput, compressionRatioArrayHighOutput));
		}
#endif

#ifdef DIGITAL_GAIN_ENABLE
#ifdef USE_JSON
		if (g_bEnableAPCParamJson)
		{
			STCHECKRESULT(IaaApc_OptionReadFromJson(&apc_option, g_apc_param_json_buff, apc_param_json_path, apc_param_json_buff_size));
		}
#endif
		g_apc_option = apc_option;
#endif
    }
    
    return MI_SUCCESS;
}

static MI_S32 ST_APC_Exit()
{
    MI_U8 u8ChnGrpIdx = 0;

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (g_bAiGrpChnEnable[u8ChnGrpIdx] == FALSE)
        {
            continue;
        }
        
        if (g_apc_handle[u8ChnGrpIdx] != NULL)
        {
            IaaApc_Free(g_apc_handle[u8ChnGrpIdx]);
            g_apc_handle[u8ChnGrpIdx] = NULL;
        }
        
        if (g_apc_working_buffer_address[u8ChnGrpIdx] != NULL)
        {
            free(g_apc_working_buffer_address[u8ChnGrpIdx]);
            g_apc_working_buffer_address[u8ChnGrpIdx] = NULL;
        }
    }

#ifdef USE_JSON
	if (g_bEnableAPCInternalJson)
	{
		if (g_apc_internal_json_buff != NULL)
        {
            free(g_apc_internal_json_buff);
            g_apc_internal_json_buff = NULL;
        }
	}
	if (g_bEnableAPCParamJson)
	{
		if (g_apc_param_json_buff != NULL)
        {
            free(g_apc_param_json_buff);
            g_apc_param_json_buff = NULL;
        }
	}
#endif
    
    return MI_SUCCESS;
}
#endif

static void *ST_AO_PlayBufPthread(void *args)
{
    MI_AUDIO_DEV AoDevId = 0;
    void *pvBuffer = NULL;
    MI_U32 u32BufferByte = AO_PLAY_UNIT_SIZE;
    MI_U32 u32ReadByte = 0;
    char play_path[1024] = {0};
    FILE *play_ao_in_fp;
	MI_U32 u32Remaining = 0;
	MI_U64 u64TStamp = 0;
    MI_S32 s32Ret = MI_SUCCESS;

    sprintf(play_path, "%s", g_pAoPlayPath);
    play_ao_in_fp = fopen(play_path, "rb");
    if (play_ao_in_fp == NULL)
    {
        ST_ERR("fopen failed.\n");
		goto RET1;
    }

    pvBuffer = malloc(u32BufferByte);
    if (pvBuffer == NULL)
    {
        ST_ERR("malloc failed.\n");
		goto RET2;
    }
    
    while (!g_bExit)
    {
        u32ReadByte = fread((MI_U8 *)pvBuffer, 1, u32BufferByte, play_ao_in_fp);
        if (u32ReadByte == 0)
        {
            fseek(play_ao_in_fp, 0, SEEK_SET);
            u32ReadByte = fread((MI_U8 *)pvBuffer, 1, u32BufferByte, play_ao_in_fp);
            if (u32ReadByte == 0)
            {
                ST_ERR("fread file does not have enough data. %d\n", u32ReadByte);
		        goto RET3;
            }
        }
        
        do
        {
            s32Ret = MI_AO_Write(AoDevId, pvBuffer, u32ReadByte, 0, 20);
            if (s32Ret != MI_AO_ERR_NOBUF && s32Ret != MI_SUCCESS)
            {
                ST_ERR("MI_AO_Write, error:%X\n", s32Ret);
                goto RET3;
            }
        } while (s32Ret == MI_AO_ERR_NOBUF);

		MI_AO_GetTimestamp(AoDevId, &u32Remaining, &u64TStamp);
		while (u32Remaining > 1000)
		{
			usleep(10 * 1000);
			MI_AO_GetTimestamp(AoDevId, &u32Remaining, &u64TStamp);
		}
    }

RET3:
    free(pvBuffer);
RET2:
    fclose(play_ao_in_fp);
RET1:
    return args;
}

static MI_S32 ST_AO_Init()
{
    MI_U8 u8AoIfIdx = 0;
    MI_AUDIO_DEV AoDevId = 0;
    MI_AO_Attr_t stAttr;
    MI_AO_GainFading_e enFading = E_MI_AO_GAIN_FADING_OFF;
    MI_S32 s32Ret = MI_SUCCESS;

    memset(&stAttr, 0x00, sizeof(MI_AO_Attr_t));
    stAttr.enFormat = E_MI_AUDIO_FORMAT_PCM_S16_LE;
    stAttr.enSoundMode = g_enAoSoundMode;
    stAttr.enSampleRate = g_enAoSampleRate;
    stAttr.u32PeriodSize = AO_PERIOD_SIZE;
    stAttr.enChannelMode = g_enAoChannelMode;
    //stAttr.enMixerSampleRate;
    STCHECKRESULT(MI_AO_Open(AoDevId, &stAttr));
    system("echo 1 > /sys/class/gpio/gpio43/value");//open amp

	if (!g_bEnableAec || g_bAiHwAecEnable)
	{
		for (u8AoIfIdx = 0; u8AoIfIdx < sizeof(g_enAoIfs) / sizeof(g_enAoIfs[0]) - 1; u8AoIfIdx++)
	    {
	        STCHECKRESULT(MI_AO_AttachIf(AoDevId, g_enAoIfs[u8AoIfIdx], 0));
	    }
	}
	else
	{
	    for (u8AoIfIdx = 0; u8AoIfIdx < sizeof(g_enAoIfs) / sizeof(g_enAoIfs[0]); u8AoIfIdx++)
	    {
	        STCHECKRESULT(MI_AO_AttachIf(AoDevId, g_enAoIfs[u8AoIfIdx], 0));
	    }
	}

    for (u8AoIfIdx = 0; u8AoIfIdx < sizeof(g_enAoIfs) / sizeof(g_enAoIfs[0]) - 1; u8AoIfIdx++)
    {
        STCHECKRESULT(MI_AO_SetVolume(AoDevId, g_s16AoVolume[u8AoIfIdx * 2], g_s16AoVolume[u8AoIfIdx * 2 + 1], enFading));
    }

    pthread_create(&g_stAoPlayBufPt, NULL, ST_AO_PlayBufPthread, NULL);

    return s32Ret;
}

static MI_S32 ST_AO_Exit()
{
    MI_U8 u8AoIfIdx = 0;
    MI_AUDIO_DEV AoDevId = 0;
    MI_S32 s32Ret = MI_SUCCESS;

    pthread_join(g_stAoPlayBufPt, NULL);

	if (!g_bEnableAec || g_bAiHwAecEnable)
	{
	    for (u8AoIfIdx = 0; u8AoIfIdx < sizeof(g_enAoIfs) / sizeof(g_enAoIfs[0]) - 1; u8AoIfIdx++)
	    {
	        STCHECKRESULT(MI_AO_DetachIf(AoDevId, g_enAoIfs[u8AoIfIdx]));
	    }
	}
	else
	{
		for (u8AoIfIdx = 0; u8AoIfIdx < sizeof(g_enAoIfs) / sizeof(g_enAoIfs[0]); u8AoIfIdx++)
	    {
	        STCHECKRESULT(MI_AO_DetachIf(AoDevId, g_enAoIfs[u8AoIfIdx]));
	    }
	}

    system("echo 0 > /sys/class/gpio/gpio43/value");//close amp
    STCHECKRESULT(MI_AO_Close(AoDevId));

    return s32Ret;
}

static void *ST_AI_GetBufPthread(void *args)
{
    MI_U8 u8ChnGrpIdx = (MI_U8)(MI_U32)args;
    MI_AUDIO_DEV AiDevId = 0;
    MI_AI_Data_t stData;
    MI_AI_Data_t stEchoRefData;
	MI_U8 *pNear = NULL;
	MI_U8 *pFar = NULL;
    char dump_path[1024] = {0};  
    MI_U32 u32ReadByte = 0;
	//MI_U32 u32ReadSize = 0;
    MI_U8 aec_ao_in_debug_buffer[AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT] = {0};
    MI_U8 aec_ai_in_debug_buffer[AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT] = {0};
    FILE * aec_ao_in_debug_fp;
    FILE * aec_ai_in_debug_fp;
    
#ifdef AUDIO_ALGO
    #ifdef dump_aec_ao_in
    FILE *                   dump_aec_ao_in_fp;
    #endif
    #ifdef dump_aec_ai_in
    FILE *                   dump_aec_ai_in_fp;
    #endif
    #ifdef dump_aec_out
    FILE *                   dump_aec_out_fp;
    #endif
    #ifdef dump_apc_in
    FILE *                   dump_apc_in_fp;
    #endif
    #ifdef dump_apc_out
    FILE *                   dump_apc_out_fp;
    #endif
#endif
    FILE *dump_ai_out_fp;
    MI_U32 u32I = 0;
    MI_S32 s32Ret = MI_SUCCESS;

    if (g_bAecAoInWithPcm)
    {
        sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_aec_ao_in_debug.pcm");
        aec_ao_in_debug_fp = fopen(dump_path, "rb");
    }
    if (g_bAecAiInWithPcm)
    {
        sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_aec_ai_in_debug.pcm");
        aec_ai_in_debug_fp = fopen(dump_path, "rb");
		/*//8分钟开始播放
		fseek(aec_ai_in_debug_fp, (AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT) *
			(((MI_U32)g_enAiSampleRate * (MI_U32)g_enAiSoundMode * (16 / 8) * (60 * 8)) /
			(AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT)), SEEK_SET);*/
    }

#ifdef AUDIO_ALGO
    if (g_bEnableAec)
    {
    #ifdef dump_aec_ao_in
        sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_aec_ao_in.pcm");
        dump_aec_ao_in_fp = fopen(dump_path, "wb+");
    #endif
    #ifdef dump_aec_ai_in
        sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_aec_ai_in.pcm");
        dump_aec_ai_in_fp = fopen(dump_path, "wb+");
    #endif
    #ifdef dump_aec_out
        sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_aec_out.pcm");
        dump_aec_out_fp = fopen(dump_path, "wb+");
    #endif
    }
    if (g_bEnableApc)
    {
    #ifdef dump_apc_in
        sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_apc_in.pcm");
        dump_apc_in_fp = fopen(dump_path, "wb+");
    #endif
    #ifdef dump_apc_out
        sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_apc_out.pcm");
        dump_apc_out_fp = fopen(dump_path, "wb+");
    #endif
    }
#endif
    sprintf(dump_path, "%s/%s%d%s", g_pDumpDirPath, "ai_chn", u8ChnGrpIdx, "_out.pcm");
    dump_ai_out_fp = fopen(dump_path, "wb");
    if (dump_ai_out_fp == NULL)
    {
        ST_ERR("fopen failed.\n");
		goto RET1;
    }

    while (!g_bExit)
    {
        if ((g_bEnableAec && (!g_bAecAoInWithPcm || !g_bAecAiInWithPcm)) || (!g_bEnableAec && !g_bAecAiInWithPcm))
        {
            if (!g_bEnableAec || g_bAiHwAecEnable)
            {
                do
                {
                    s32Ret = MI_AI_Read(AiDevId, u8ChnGrpIdx, &stData, NULL, 10);
                    if (s32Ret != MI_AI_ERR_NOBUF && s32Ret != MI_SUCCESS)
                    {
                        ST_ERR("MI_AI_Read, error:%X\n", s32Ret);
                        goto RET2;
                    }
                } while (s32Ret == MI_AI_ERR_NOBUF);
				pNear = (MI_U8 *)stData.apvBuffer[0];
				if (g_bAiHwAecEnable)
				{
					pFar = (MI_U8 *)stData.apvBuffer[1];
				}
            }
			else
            {
                do
                {
                    s32Ret = MI_AI_Read(AiDevId, u8ChnGrpIdx, &stData, &stEchoRefData, 10);
                    if (s32Ret != MI_AI_ERR_NOBUF && s32Ret != MI_SUCCESS)
                    {
                        ST_ERR("MI_AI_Read, error:%X\n", s32Ret);
                        goto RET2;
                    }
                } while (s32Ret == MI_AI_ERR_NOBUF);
				pNear = (MI_U8 *)stData.apvBuffer[0];
				pFar = (MI_U8 *)stEchoRefData.apvBuffer[0];
            }
        }
    
        if (g_bAecAoInWithPcm)
        {
            pFar = aec_ao_in_debug_buffer;
            u32ReadByte = fread(pFar, 1, AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT, aec_ao_in_debug_fp);
            if (u32ReadByte != AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT)
            {
                printf("Debug audio finished.\n");
                goto RET3;
            }
        }

        if (g_bAecAiInWithPcm)
        {
        	/*//播放1分钟后结束播放
        	u32ReadSize += u32ReadByte;
			if (u32ReadSize >= ((AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT) *
				(((MI_U32)g_enAiSampleRate * (MI_U32)g_enAiSoundMode * (16 / 8) * (60 * 1)) /
				(AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT))))
			{
				printf("Debug audio finished.\n");
                goto RET4;
			}*/
            pNear = aec_ai_in_debug_buffer;
            u32ReadByte = fread(pNear, 1, AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT, aec_ai_in_debug_fp);
			if (u32ReadByte != AI_ALGO_ROUND_SIZE * AI_ALGO_ROUND_CNT)
            {
                printf("Debug audio finished.\n");
                goto RET3;
            }
        }

        for (u32I = 0; u32I < AI_ALGO_ROUND_CNT; u32I++)
        {
#ifdef AUDIO_ALGO
            if (g_bEnableAec)
            {
    #ifdef dump_aec_ao_in
                fwrite(pFar + u32I * AI_ALGO_ROUND_SIZE, 1, AI_ALGO_ROUND_SIZE, dump_aec_ao_in_fp);
    #endif
    #ifdef dump_aec_ai_in
                fwrite(pNear + u32I * AI_ALGO_ROUND_SIZE, 1, AI_ALGO_ROUND_SIZE, dump_aec_ai_in_fp);
    #endif
                s32Ret = IaaAec_Run(g_aec_handle[u8ChnGrpIdx], (short*)(pNear + u32I * AI_ALGO_ROUND_SIZE), (short *)(pFar + u32I * AI_ALGO_ROUND_SIZE));
                if(ALGO_AEC_RET_SUCCESS != s32Ret)
                {
                    ST_ERR("IaaAec_Run, error:%X\n", s32Ret);
                }
    #ifdef dump_aec_out
                fwrite(pNear + u32I * AI_ALGO_ROUND_SIZE, 1, AI_ALGO_ROUND_SIZE, dump_aec_out_fp);
    #endif
            }
            if (g_bEnableApc)
            {
    #ifdef dump_apc_in
                fwrite(pNear + u32I * AI_ALGO_ROUND_SIZE, 1, AI_ALGO_ROUND_SIZE, dump_apc_in_fp);
    #endif
#ifdef DIGITAL_GAIN_ENABLE
				s32Ret = IaaApc_ApplyDigitalGain(g_apc_handle[u8ChnGrpIdx], (short*)(pNear + u32I * AI_ALGO_ROUND_SIZE), g_apc_option.digital_gain[0]);
                if(ALGO_APC_RET_SUCCESS != s32Ret)
                {
                    ST_ERR("IaaApc_ApplyDigitalGain, error:%X\n", s32Ret);
                }
#endif
                s32Ret = IaaApc_Run(g_apc_handle[u8ChnGrpIdx], (short*)(pNear + u32I * AI_ALGO_ROUND_SIZE));
                if(ALGO_APC_RET_SUCCESS != s32Ret)
                {
                    ST_ERR("IaaApc_Run, error:%X\n", s32Ret);
                }
#ifdef FILTER_ENABLE
				s32Ret = IaaApc_FilterApply(g_apc_handle[u8ChnGrpIdx], (short*)(pNear + u32I * AI_ALGO_ROUND_SIZE));
                if(ALGO_APC_RET_SUCCESS != s32Ret)
                {
                    ST_ERR("IaaApc_FilterApply, error:%X\n", s32Ret);
                }
#endif
#ifdef DIGITAL_GAIN_ENABLE
				s32Ret = IaaApc_ApplyDigitalGain(g_apc_handle[u8ChnGrpIdx], (short*)(pNear + u32I * AI_ALGO_ROUND_SIZE), g_apc_option.digital_gain[1]);
                if(ALGO_APC_RET_SUCCESS != s32Ret)
                {
                    ST_ERR("IaaApc_ApplyDigitalGain, error:%X\n", s32Ret);
                }
#endif
    #ifdef dump_apc_out
                fwrite(pNear + u32I * AI_ALGO_ROUND_SIZE, 1, AI_ALGO_ROUND_SIZE, dump_apc_out_fp);
    #endif
            }
#endif
            fwrite(pNear + u32I * AI_ALGO_ROUND_SIZE, 1, AI_ALGO_ROUND_SIZE, dump_ai_out_fp);
        }

		if ((g_bEnableAec && (!g_bAecAoInWithPcm || !g_bAecAiInWithPcm)) || (!g_bEnableAec && !g_bAecAiInWithPcm))
		{
			if (!g_bEnableAec || g_bAiHwAecEnable)
	        {
	        	MI_AI_ReleaseData(AiDevId, u8ChnGrpIdx, &stData, NULL);
			}
	        else
	        {
				MI_AI_ReleaseData(AiDevId, u8ChnGrpIdx, &stData, &stEchoRefData);
	        }
		}
    }

    goto RET2;

RET3:
	if ((g_bEnableAec && (!g_bAecAoInWithPcm || !g_bAecAiInWithPcm)) || (!g_bEnableAec && !g_bAecAiInWithPcm))
	{
		if (!g_bEnableAec || g_bAiHwAecEnable)
		{
			MI_AI_ReleaseData(AiDevId, u8ChnGrpIdx, &stData, NULL);
		}
		else
		{
			MI_AI_ReleaseData(AiDevId, u8ChnGrpIdx, &stData, &stEchoRefData);
		}
	}
RET2:
    fclose(dump_ai_out_fp);
RET1:
#ifdef AUDIO_ALGO
    if (g_bEnableApc)
    {
    #ifdef dump_apc_out
        fclose(dump_apc_out_fp);
    #endif
    #ifdef dump_apc_in
        fclose(dump_apc_in_fp);
    #endif
    }
    if (g_bEnableAec)
    {
    #ifdef dump_aec_out
        fclose(dump_aec_out_fp);
    #endif
    #ifdef dump_aec_ai_in
        fclose(dump_aec_ai_in_fp);
    #endif
    #ifdef dump_aec_ao_in
        fclose(dump_aec_ao_in_fp);
    #endif
    }
#endif

    if (g_bAecAiInWithPcm)
    {
        fclose(aec_ai_in_debug_fp);
    }
    if (g_bAecAoInWithPcm)
    {
        fclose(aec_ao_in_debug_fp);
    }
    
    return args;
}

static MI_S32 ST_AI_Init()
{
    MI_U8 u8AiIfIdx = 0;
    MI_U8 u8ChnGrpIdx = 0;
    MI_AUDIO_DEV AiDevId = 0;
    MI_AI_Attr_t stAttr;
    MI_S16 s16GainsBuf[AI_GRP_CHN_NUM_MAX] = {0};
    MI_SYS_ChnPort_t stChnPort;
    MI_U8 u8I = 0;
    MI_S32 s32Ret = MI_SUCCESS;

    memset(&stAttr, 0x00, sizeof(MI_AI_Attr_t));
    stAttr.enFormat = E_MI_AUDIO_FORMAT_PCM_S16_LE;
    stAttr.enSoundMode = g_enAiSoundMode;
    stAttr.enSampleRate = g_enAiSampleRate;
    stAttr.u32PeriodSize = AI_PERIOD_SIZE;
	if (stAttr.enSoundMode == E_MI_AUDIO_SOUND_MODE_MONO || g_bAiHwAecEnable)
	{
		stAttr.bInterleaved = FALSE;
	}
    else
    {
        stAttr.bInterleaved = TRUE;
    }
    STCHECKRESULT(MI_AI_Open(AiDevId, &stAttr));

    if (!g_bEnableAec || g_bAiHwAecEnable)
    {
        STCHECKRESULT(MI_AI_AttachIf(AiDevId, g_enAiIfs, sizeof(g_enAiIfs) / sizeof(g_enAiIfs[0]) - 1));
        
    }
    else
    {
        STCHECKRESULT(MI_AI_AttachIf(AiDevId, g_enAiIfs, sizeof(g_enAiIfs) / sizeof(g_enAiIfs[0])));
    }

    for (u8AiIfIdx = 0; u8AiIfIdx < sizeof(g_enAiIfs) / sizeof(g_enAiIfs[0]) - 1; u8AiIfIdx++)
    {
        STCHECKRESULT(MI_AI_SetIfGain(g_enAiIfs[u8AiIfIdx], g_s16AiIfGain[u8AiIfIdx * 2], g_s16AiIfGain[u8AiIfIdx * 2 + 1]));
    }

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (g_bAiGrpChnEnable[u8ChnGrpIdx] == FALSE)
        {
            continue;
        }
    
        for (u8I = 0; u8I < (MI_U8)g_enAiSoundMode; u8I++)
        {
            s16GainsBuf[u8I] = g_s16AiGain[(MI_U8)g_enAiSoundMode * u8ChnGrpIdx + u8I];
        }
        STCHECKRESULT(MI_AI_SetGain(AiDevId, u8ChnGrpIdx, s16GainsBuf, (MI_U8)g_enAiSoundMode));
    }
    if (g_bEnableAec && !g_bAiHwAecEnable)
    {
        STCHECKRESULT(MI_AI_SetGain(AiDevId, MI_AI_ECHO_CHN_GROUP_ID, g_s16AiEchoGain, sizeof(g_s16AiEchoGain) / sizeof(g_s16AiEchoGain[0])));
    }

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (!g_bAiGrpChnEnable[u8ChnGrpIdx])
        {
            continue;
        }
        
        memset(&stChnPort, 0x00, sizeof(MI_SYS_ChnPort_t));
        stChnPort.eModId = E_MI_MODULE_ID_AI;
        stChnPort.u32DevId = AiDevId;
        stChnPort.u32ChnId = (MI_U32)u8ChnGrpIdx;
        stChnPort.u32PortId = 0;
        STCHECKRESULT(MI_SYS_SetChnOutputPortDepth(0, &stChnPort, 8, 8));
    
        STCHECKRESULT(MI_AI_EnableChnGroup(AiDevId, u8ChnGrpIdx));
    }
    
    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (!g_bAiGrpChnEnable[u8ChnGrpIdx])
        {
            continue;
        }
        
        pthread_create(&g_stAiGetBufPt[u8ChnGrpIdx], NULL, ST_AI_GetBufPthread, (void *)(MI_U32)u8ChnGrpIdx);
    }

    return s32Ret;
}

static MI_S32 ST_AI_Exit()
{
    MI_U8 u8ChnGrpIdx = 0;
    MI_AUDIO_DEV AiDevId = 0;
    MI_S32 s32Ret = MI_SUCCESS;

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (!g_bAiGrpChnEnable[u8ChnGrpIdx])
        {
            continue;
        }

        pthread_join(g_stAiGetBufPt[u8ChnGrpIdx], NULL);
    }

    for (u8ChnGrpIdx = 0; u8ChnGrpIdx < AI_GRP_CHN_NUM_MAX; u8ChnGrpIdx++)
    {
        if (!g_bAiGrpChnEnable[u8ChnGrpIdx])
        {
            continue;
        }
        
        STCHECKRESULT(MI_AI_DisableChnGroup(AiDevId, u8ChnGrpIdx));
    }

    STCHECKRESULT(MI_AI_Close(AiDevId));

    return s32Ret;
}

static MI_S32 ST_Audio_Init()
{
    MI_S32 s32Ret = MI_SUCCESS;

    STCHECKRESULT(ST_SYS_Init());
#ifdef AUDIO_ALGO
    if (g_bEnableAec)
    {
        ST_AEC_Init();
    }
    if (g_bEnableApc)
    {
        ST_APC_Init();
    }
#endif
    if (g_pAoPlayPath != NULL)
    {
        STCHECKRESULT(ST_AO_Init());
    }
    STCHECKRESULT(ST_AI_Init());

    return s32Ret;
}

static MI_S32 ST_Audio_Exit()
{
    MI_S32 s32Ret = MI_SUCCESS;

    STCHECKRESULT(ST_AI_Exit());
    if (g_pAoPlayPath != NULL)
    {
        STCHECKRESULT(ST_AO_Exit());
    }
#ifdef AUDIO_ALGO
    if (g_bEnableApc)
    {
        ST_APC_Exit();
    }
    if (g_bEnableAec)
    {
        ST_AEC_Exit();
    }
#endif
    STCHECKRESULT(ST_SYS_Exit());

    return s32Ret;
}

int main(int argc, char **argv)
{
    if (argc < 2)
	{
        ST_Audio_Usage();
		return -1;
	}

    STCHECKRESULT(ST_Audio_GetInputParam(argc, argv));

    switch (g_stAudioInputParam.u8Case)
    {
    case 0:
        ST_INFO("Case 0: Open AEC\n");
        g_bAecAoInWithPcm = FALSE;
        g_bAecAiInWithPcm = FALSE;
        g_enAoChannelMode = E_MI_AO_CHANNEL_MODE_DOUBLE_MONO;
        g_bAiGrpChnEnable[0] = TRUE;
        g_bAiGrpChnEnable[1] = FALSE;
		g_bEnableAec = TRUE;
		if (g_bEnableAec)
		{
			g_bAiHwAecEnable = TRUE;//FALSE;
			if (g_bAiHwAecEnable)
			{
				g_enAiSoundMode = (MI_AUDIO_SoundMode_e)((MI_U32)g_enAiSoundMode + 1);
			}
		}
		else
		{
			g_bAiHwAecEnable = FALSE;
		}
        break;
    case 1:
        ST_INFO("Case 1: Open AEC\n");
        g_bAecAoInWithPcm = TRUE;
        g_bAecAiInWithPcm = TRUE;
        g_enAoChannelMode = E_MI_AO_CHANNEL_MODE_DOUBLE_MONO;
        g_bAiGrpChnEnable[0] = TRUE;
        g_bAiGrpChnEnable[1] = FALSE;
		g_bEnableAec = TRUE;
        if (g_bEnableAec)
		{
			g_bAiHwAecEnable = TRUE;//FALSE;
			if (g_bAiHwAecEnable)
			{
				g_enAiSoundMode = (MI_AUDIO_SoundMode_e)((MI_U32)g_enAiSoundMode + 1);
			}
		}
		else
		{
			g_bAiHwAecEnable = FALSE;
		}
        break;
    case 2:
        ST_INFO("Case 2: Open AEC\n");
        g_bAecAoInWithPcm = TRUE;
        g_bAecAiInWithPcm = FALSE;
        g_enAoChannelMode = E_MI_AO_CHANNEL_MODE_DOUBLE_MONO;
        g_bAiGrpChnEnable[0] = TRUE;
        g_bAiGrpChnEnable[1] = FALSE;
		g_bEnableAec = TRUE;
        if (g_bEnableAec)
		{
			g_bAiHwAecEnable = TRUE;//FALSE;
			if (g_bAiHwAecEnable)
			{
				g_enAiSoundMode = (MI_AUDIO_SoundMode_e)((MI_U32)g_enAiSoundMode + 1);
			}
		}
		else
		{
			g_bAiHwAecEnable = FALSE;
		}
        break;
    case 3:
        ST_INFO("Case 3: Open AEC\n");
        g_bAecAoInWithPcm = FALSE;
        g_bAecAiInWithPcm = TRUE;
        g_enAoChannelMode = E_MI_AO_CHANNEL_MODE_DOUBLE_MONO;
        g_bAiGrpChnEnable[0] = TRUE;
        g_bAiGrpChnEnable[1] = FALSE;
		g_bEnableAec = TRUE;
        if (g_bEnableAec)
		{
			g_bAiHwAecEnable = TRUE;//FALSE;
			if (g_bAiHwAecEnable)
			{
				g_enAiSoundMode = (MI_AUDIO_SoundMode_e)((MI_U32)g_enAiSoundMode + 1);
			}
		}
		else
		{
			g_bAiHwAecEnable = FALSE;
		}
        break;
    case 4:
        ST_INFO("Case 4: Close AEC\n");
        g_bAecAoInWithPcm = FALSE;
        g_bAecAiInWithPcm = FALSE;
        g_enAoChannelMode = E_MI_AO_CHANNEL_MODE_DOUBLE_MONO;
        g_bAiGrpChnEnable[0] = TRUE;
        g_bAiGrpChnEnable[1] = FALSE;
		g_bEnableAec = FALSE;
        if (g_bEnableAec)
		{
			g_bAiHwAecEnable = TRUE;//FALSE;
			if (g_bAiHwAecEnable)
			{
				g_enAiSoundMode = (MI_AUDIO_SoundMode_e)((MI_U32)g_enAiSoundMode + 1);
			}
		}
		else
		{
			g_bAiHwAecEnable = FALSE;
		}
        break;
    case 5:
        ST_INFO("Case 5: Close AEC\n");
        g_bAecAoInWithPcm = FALSE;
        g_bAecAiInWithPcm = TRUE;
        g_enAoChannelMode = E_MI_AO_CHANNEL_MODE_DOUBLE_MONO;
        g_bAiGrpChnEnable[0] = TRUE;
        g_bAiGrpChnEnable[1] = FALSE;
		g_bEnableAec = FALSE;
        if (g_bEnableAec)
		{
			g_bAiHwAecEnable = TRUE;//FALSE;
			if (g_bAiHwAecEnable)
			{
				g_enAiSoundMode = (MI_AUDIO_SoundMode_e)((MI_U32)g_enAiSoundMode + 1);
			}
		}
		else
		{
			g_bAiHwAecEnable = FALSE;
		}
        break;
    default:
        ST_ERR("The case is invaild!\n");
        ST_Audio_Usage();
        return -1;
    }

    STCHECKRESULT(ST_Audio_Init());

    while (!g_bExit)
    {
        MI_U32 u32Select = 0xff;
        printf("select 0: exit\n");
        
        scanf("%d", &u32Select);
        ST_Flush();
        if (u32Select == 0)
        {
            g_bExit = TRUE;
        }

        usleep(THREAD_SLEEP_TIME_US);
    }

    STCHECKRESULT(ST_Audio_Exit());

    return 0;
}

