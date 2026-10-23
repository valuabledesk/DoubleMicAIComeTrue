echo 43 > /sys/class/gpio/export
echo out > /sys/class/gpio/gpio43/direction
echo 0 > /sys/class/gpio/gpio43/value

export AUDIO_DUMP_PATH=./dump
export AUDIO_AEC_DUMP=1
export AUDIO_APC_DUMP=1
export AUDIO_ANR_DUMP=1
export AUDIO_EQ_DUMP=1
export AUDIO_AGC_DUMP=1

./prog_audio_audio_all 0 16K_16bit_MONO_30s.pcm dump
#mv ./dump/Audio_AEC_far_end_data_0.pcm ./dump/ai_chn0_aec_ao_in_debug.pcm
#mv ./dump/Audio_AEC_near_end_data_0.pcm ./dump/ai_chn0_aec_ai_in_debug.pcm
#./prog_audio_audio_all 1 "" dump
