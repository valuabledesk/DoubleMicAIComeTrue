DEP += audio common

$(eval $(call CHECKIF_CONFIG_SET,enable,interface_ao))
$(eval $(call CHECKIF_CONFIG_SET,enable,interface_ai))
