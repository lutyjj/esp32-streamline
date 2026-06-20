"""ESPHome transport for the StreamLine ELI1 protocol."""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import microphone
from esphome.const import CONF_ID

DEPENDENCIES = ["microphone"]
CODEOWNERS = ["@lutyjj"]

CONF_MICROPHONE_ID = "microphone_id"
CONF_TARGET_HOST = "target_host"
CONF_TARGET_PORT = "target_port"
CONF_SWAP_STEREO = "swap_stereo"

streamline_ns = cg.esphome_ns.namespace("streamline")
StreamLine = streamline_ns.class_("StreamLine", cg.Component)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(StreamLine),
        cv.Required(CONF_MICROPHONE_ID): cv.use_id(microphone.Microphone),
        cv.Required(CONF_TARGET_HOST): cv.string_strict,
        cv.Optional(CONF_TARGET_PORT, default=39000): cv.port,
        cv.Optional(CONF_SWAP_STEREO, default=True): cv.boolean,
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    mic = await cg.get_variable(config[CONF_MICROPHONE_ID])
    cg.add(var.set_microphone(mic))
    cg.add(var.set_target_host(config[CONF_TARGET_HOST]))
    cg.add(var.set_target_port(config[CONF_TARGET_PORT]))
    cg.add(var.set_swap_stereo(config[CONF_SWAP_STEREO]))
