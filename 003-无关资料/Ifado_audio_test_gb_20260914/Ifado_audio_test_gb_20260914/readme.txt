程序运行方法：
先移植音频库和app到sdk，编译出prog_audio_audio_all，放到bin目录

#初始化功放管脚
echo 43 > /sys/class/gpio/export
echo out > /sys/class/gpio/gpio43/direction
echo 0 > /sys/class/gpio/gpio43/value

#设置dump数据的环境变量，会生成Audio_AEC_far_end_data.pcm和Audio_AEC_near_end_data.pcm等文件
export AUDIO_DUMP_PATH=./dump
export AUDIO_AEC_DUMP=1
export AUDIO_APC_DUMP=1
export AUDIO_ANR_DUMP=1
export AUDIO_EQ_DUMP=1
export AUDIO_AGC_DUMP=1

#Case 0，正常运行程序，ao_play.pcm是可选项，指ao文件路径
./prog_audio_audio_all 0 [ao_play.pcm] [dump]

#Case 1，debug模式，通过aec_ao_in pcm文件和aec_ai_in pcm文件生成最终文件
mv ./dump/Audio_AEC_far_end_data_0.pcm ./dump/ai_chn0_aec_ao_in_debug.pcm
mv ./dump/Audio_AEC_near_end_data_0.pcm ./dump/ai_chn0_aec_ai_in_debug.pcm
./prog_audio_audio_all 1 "" [dump]

#Case 2，debug模式
mv ./dump/Audio_AEC_far_end_data_0.pcm ./dump/ai_chn0_aec_ao_in_debug.pcm
./prog_audio_audio_all 2 "" [dump]

#Case 3，debug模式
mv ./dump/Audio_AEC_near_end_data_0.pcm ./dump/ai_chn0_aec_ai_in_debug.pcm
./prog_audio_audio_all 3 [ao_play.pcm] [dump]

#Case 4，关AEC，正常运行程序，ao_play.pcm是可选项，指ao文件路径
./prog_audio_audio_all 4 [ao_play.pcm] [dump]

#Case 5，关AEC，debug模式，通过ai_in pcm文件生成最终文件
mv ./dump/Audio_APC_input_data_0.pcm ./dump/ai_chn0_aec_ai_in_debug.pcm
./prog_audio_audio_all 5 [ao_play.pcm] [dump]
