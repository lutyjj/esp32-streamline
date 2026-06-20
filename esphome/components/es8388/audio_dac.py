import esphome.codegen as cg
from esphome.components import i2c
from esphome.components.audio_dac import AudioDac
import esphome.config_validation as cv
from esphome.const import CONF_ID

CODEOWNERS = ["@P4uLT", "@lutyjj"]
CONF_ES8388_ID = "es8388_id"
CONF_AUTO_GAIN = "auto_gain"
CONF_MIC_GAIN = "mic_gain"

# ES8388 ADC input PGA: nine 3 dB steps mapped to the ADCCONTROL1 nibble.
MIC_GAIN = {
    "0DB": 0,
    "3DB": 1,
    "6DB": 2,
    "9DB": 3,
    "12DB": 4,
    "15DB": 5,
    "18DB": 6,
    "21DB": 7,
    "24DB": 8,
}

es8388_ns = cg.esphome_ns.namespace("es8388")

ES8388 = es8388_ns.class_("ES8388", AudioDac, cg.Component, i2c.I2CDevice)

DEPENDENCIES = ["i2c"]

CONFIG_SCHEMA = (
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(ES8388),
            # The upstream component hardcodes ALC on for voice recording, which
            # clips a line-level source. Default to a clean fixed-gain line-in;
            # opt into automatic level control explicitly.
            cv.Optional(CONF_AUTO_GAIN, default=False): cv.boolean,
            cv.Optional(CONF_MIC_GAIN, default="0dB"): cv.enum(MIC_GAIN, upper=True),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
    .extend(i2c.i2c_device_schema(0x10))
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await i2c.register_i2c_device(var, config)
    cg.add(var.set_auto_gain(config[CONF_AUTO_GAIN]))
    cg.add(var.set_mic_gain(config[CONF_MIC_GAIN]))
