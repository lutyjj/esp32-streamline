#include <Arduino.h>
#include <AudioBoard.h>
#include <math.h>

#include "driver/i2s.h"
#include "esp_err.h"

using namespace audio_driver;

namespace {

constexpr i2s_port_t I2S_PORT = I2S_NUM_0;
constexpr int SAMPLE_RATE = 48000;
constexpr int CHANNELS = 2;
constexpr int BITS_PER_SAMPLE = 16;
constexpr size_t FRAMES_PER_READ = 256;

struct StereoSample {
  int16_t left;
  int16_t right;
};

struct LevelStats {
  uint64_t frames = 0;
  uint64_t sum_sq_l = 0;
  uint64_t sum_sq_r = 0;
  int32_t peak_l = 0;
  int32_t peak_r = 0;
  uint32_t last_print_ms = 0;
};

StereoSample samples[FRAMES_PER_READ];
LevelStats stats;

void fail_if_error(const char *step, esp_err_t err) {
  if (err == ESP_OK) {
    return;
  }

  Serial.printf("ERROR: %s failed: %s\n", step, esp_err_to_name(err));
  while (true) {
    delay(1000);
  }
}

void begin_i2s() {
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
  config.sample_rate = SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 8;
  config.dma_buf_len = FRAMES_PER_READ;
  config.use_apll = true;
  config.tx_desc_auto_clear = false;
  config.fixed_mclk = 0;
  config.mclk_multiple = I2S_MCLK_MULTIPLE_256;
  config.bits_per_chan = I2S_BITS_PER_CHAN_16BIT;

  i2s_pin_config_t pins = {};
  pins.mck_io_num = 0;
  pins.bck_io_num = 27;
  pins.ws_io_num = 25;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = 35;

  fail_if_error("i2s_driver_install", i2s_driver_install(I2S_PORT, &config, 0, nullptr));
  fail_if_error("i2s_set_pin", i2s_set_pin(I2S_PORT, &pins));
  fail_if_error("i2s_zero_dma_buffer", i2s_zero_dma_buffer(I2S_PORT));
}

input_device_t selected_input() {
#if AUDIO_INPUT_LINE == 2
  return ADC_INPUT_LINE2;
#else
  return ADC_INPUT_LINE1;
#endif
}

void begin_codec() {
  AudioDriverLogger.begin(Serial, AudioDriverLogLevel::Warning);

  CodecConfig config;
  config.input_device = selected_input();
  config.output_device = DAC_OUTPUT_NONE;
  config.i2s.bits = BIT_LENGTH_16BITS;
  config.i2s.rate = RATE_48K;
  config.i2s.channels = CHANNELS2;
  config.i2s.fmt = I2S_NORMAL;
  config.i2s.mode = MODE_SLAVE;

  if (!AudioKitEs8388V1.begin(config)) {
    Serial.println("ERROR: AudioKitEs8388V1.begin failed");
    while (true) {
      delay(1000);
    }
  }

  if (!AudioKitEs8388V1.setInputVolume(AUDIO_INPUT_GAIN)) {
    Serial.println("WARN: setInputVolume failed");
  }
}

void update_levels(const StereoSample *buffer, size_t frames) {
  for (size_t i = 0; i < frames; ++i) {
    const int32_t left = buffer[i].left;
    const int32_t right = buffer[i].right;
    const int32_t abs_l = abs(left);
    const int32_t abs_r = abs(right);

    if (abs_l > stats.peak_l) {
      stats.peak_l = abs_l;
    }
    if (abs_r > stats.peak_r) {
      stats.peak_r = abs_r;
    }

    stats.sum_sq_l += static_cast<uint64_t>(left * left);
    stats.sum_sq_r += static_cast<uint64_t>(right * right);
  }

  stats.frames += frames;
}

void maybe_print_levels() {
  const uint32_t now = millis();
  if (stats.last_print_ms == 0) {
    stats.last_print_ms = now;
  }
  if (now - stats.last_print_ms < 1000 || stats.frames == 0) {
    return;
  }

  const float rms_l = sqrtf(static_cast<float>(stats.sum_sq_l) / stats.frames);
  const float rms_r = sqrtf(static_cast<float>(stats.sum_sq_r) / stats.frames);
  const float peak_db_l = stats.peak_l > 0 ? 20.0f * log10f(static_cast<float>(stats.peak_l) / 32767.0f) : -120.0f;
  const float peak_db_r = stats.peak_r > 0 ? 20.0f * log10f(static_cast<float>(stats.peak_r) / 32767.0f) : -120.0f;

  Serial.printf("frames=%u rms_l=%.1f rms_r=%.1f peak_l=%d peak_r=%d peak_db_l=%.1f peak_db_r=%.1f\n",
                static_cast<unsigned>(stats.frames), rms_l, rms_r, static_cast<int>(stats.peak_l),
                static_cast<int>(stats.peak_r), peak_db_l, peak_db_r);

  stats = {};
  stats.last_print_ms = now;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println();
  Serial.println("ESP32 Audio Kit ES8388 input level meter");
  Serial.printf("sample_rate=%d channels=%d bits=%d input_line=%d input_gain=%d\n", SAMPLE_RATE, CHANNELS,
                BITS_PER_SAMPLE, AUDIO_INPUT_LINE, AUDIO_INPUT_GAIN);

  begin_i2s();
  begin_codec();
  Serial.println("capture started");
}

void loop() {
  size_t bytes_read = 0;
  const esp_err_t err = i2s_read(I2S_PORT, samples, sizeof(samples), &bytes_read, pdMS_TO_TICKS(1000));

  if (err != ESP_OK) {
    Serial.printf("ERROR: i2s_read failed: %s\n", esp_err_to_name(err));
    delay(1000);
    return;
  }

  const size_t frames = bytes_read / sizeof(StereoSample);
  if (frames == 0) {
    Serial.println("WARN: i2s_read returned no frames");
    return;
  }

  update_levels(samples, frames);
  maybe_print_levels();
}
