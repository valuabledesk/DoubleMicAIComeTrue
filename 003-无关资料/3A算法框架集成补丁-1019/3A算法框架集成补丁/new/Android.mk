# Copyright (C) 2012 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)

LOCAL_MODULE := audio.primary.$(TARGET_BOARD_HARDWARE)
LOCAL_MODULE_RELATIVE_PATH := hw
LOCAL_SRC_FILES := \
	audio_hw.c \
	alsa_route.c \
	alsa_mixer.c \
	voice_preprocess.c \
	audio_hw_hdmi.c
LOCAL_C_INCLUDES += \
	external/tinyalsa/include \
	$(call include-path-for, audio-utils) \
	$(call include-path-for, audio-route) \
	$(call include-path-for, speex)

LOCAL_CFLAGS := -Wno-unused-parameter
ifeq ($(strip $(TARGET_BOARD_PLATFORM_PRODUCT)), box)
LOCAL_CFLAGS += -DBOX_HAL
endif
ifeq ($(strip $(TARGET_BOARD_PLATFORM)),rk3228)
	LOCAL_CFLAGS += -DRK3228
endif
ifeq ($(strip $(TARGET_BOARD_PLATFORM)),rk322x)
	LOCAL_CFLAGS += -DRK3228
endif
LOCAL_SHARED_LIBRARIES += libdl
LOCAL_LDLIBS += -ldl
LOCAL_SHARED_LIBRARIES := libc liblog libcutils libtinyalsa libaudioutils libaudioroute libhardware_legacy libspeexresampler
LOCAL_STATIC_LIBRARIES := libspeex libmedia_helper
LOCAL_MODULE_TAGS := optional
include $(BUILD_SHARED_LIBRARY)

include $(CLEAR_VARS)
LOCAL_SRC_FILES:= amix.c alsa_mixer.c
LOCAL_MODULE:= amix
LOCAL_SHARED_LIBRARIES := libc libcutils
LOCAL_MODULE_TAGS:= debug
include $(BUILD_EXECUTABLE)

include $(CLEAR_VARS)
LOCAL_MODULE := libvoiceprocess
LOCAL_MODULE_TAGS := optional
LOCAL_MODULE_CLASS := SHARED_LIBRARIES
LOCAL_MODULE_STEM := $(LOCAL_MODULE)
LOCAL_MODULE_SUFFIX := .so
LOCAL_SRC_FILES := libvoiceprocess.so
include $(BUILD_PREBUILT)
