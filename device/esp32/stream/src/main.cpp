#include <Arduino.h>
#include <ArduinoJson.h>
#include <AudioBoard.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

#include "Driver/es8388/es8388.h"
#include "driver/i2s.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "generated_web_ui.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"

#include <errno.h>

#if __has_include("local_config.h")
#include "local_config.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

#ifndef STREAMLINE_TARGET_HOST
#define STREAMLINE_TARGET_HOST ""
#endif

#ifndef STREAMLINE_TARGET_PORT
#define STREAMLINE_TARGET_PORT 39000
#endif

#ifndef DEFAULT_INPUT_GAIN
#define DEFAULT_INPUT_GAIN AUDIO_INPUT_GAIN
#endif

#ifndef DEFAULT_INPUT_LINE
#define DEFAULT_INPUT_LINE AUDIO_INPUT_LINE
#endif

#ifndef DEFAULT_ADC_ATTEN_DB
#define DEFAULT_ADC_ATTEN_DB 0
#endif

// Diagnostics mode exposes per-packet send/blocked timing and EAGAIN counts
// over serial and /api/status. Timing is always collected (negligible cost,
// keeps the send hot path branchless); only reporting is gated.
//
// Flip at runtime with the `diag` serial command (persisted to NVS) or build a
// permanently-on diagnostic image with -D STREAMLINE_DIAGNOSTICS=1.
#ifndef STREAMLINE_DIAGNOSTICS
#define STREAMLINE_DIAGNOSTICS 0
#endif

// The normal-mode web console is read-only and disabled by default. Setup AP mode
// always starts the console because it is the only HTTP configuration surface.
// When enabled, loop()/handleClient() runs in loopTask at the lowest priority on
// core 1 and is preempted by both audio tasks. Toggle normal-mode access with the
// `web` serial command (persisted to NVS).
#ifndef STREAMLINE_WEB_SERVER
#define STREAMLINE_WEB_SERVER 0
#endif

#ifndef STREAMLINE_VERSION
#define STREAMLINE_VERSION "0.1.0"
#endif

using namespace audio_driver;

namespace {

constexpr i2s_port_t I2S_PORT = I2S_NUM_0;
constexpr int SAMPLE_RATE = 48000;
constexpr int CHANNELS = 2;
constexpr int BITS_PER_SAMPLE = 16;
constexpr size_t FRAMES_PER_PACKET = 256;
constexpr uint32_t SERIAL_REPORT_MS = 1000;
constexpr int32_t CLIP_THRESHOLD = 32760;
constexpr uint8_t MAX_ADC_ATTEN_DB = 48;
constexpr UBaseType_t AUDIO_QUEUE_DEPTH = 32;
constexpr TickType_t NETWORK_RETRY_TICKS = pdMS_TO_TICKS(250);
constexpr int TCP_SEND_TIMEOUT_MS = 250;
constexpr int TCP_CONNECT_TIMEOUT_MS = 250;
constexpr size_t TCP_SEND_CHUNK_BYTES = 1460;
constexpr char STREAM_MAGIC[] = "ELI1";
constexpr uint8_t STREAM_VERSION = 1;
constexpr char FIRMWARE_VERSION[] = STREAMLINE_VERSION;

struct StereoSample {
  int16_t left;
  int16_t right;
};

struct __attribute__((packed)) PacketHeader {
  char magic[4];
  uint8_t version;
  uint8_t header_size;
  uint8_t channels;
  uint8_t bits_per_sample;
  uint32_t sequence;
  uint32_t sample_rate;
  uint32_t frames;
  uint32_t payload_bytes;
};
static_assert(sizeof(PacketHeader) == 24, "PacketHeader must match the wire protocol");
static_assert(sizeof(StereoSample) == 4, "StereoSample must be packed 16-bit stereo PCM");

struct StreamStats {
  uint32_t packets = 0;
  uint32_t bytes = 0;
  uint32_t read_errors = 0;
  uint32_t short_reads = 0;
  uint32_t queue_drops = 0;
  uint32_t network_errors = 0;
  uint32_t reconnects = 0;
  uint32_t queue_depth = 0;
  uint32_t network_send_us = 0;
  uint32_t network_blocked_us = 0;
  uint32_t send_eagain = 0;
  uint32_t send_calls = 0;
  uint32_t clipped_samples = 0;
  int32_t peak_abs_left = 0;
  int32_t peak_abs_right = 0;
  uint64_t sum_abs_left = 0;
  uint64_t sum_abs_right = 0;
  uint32_t frames_processed = 0;
  uint32_t last_report_ms = 0;
};

struct TransportTotals {
  uint32_t queue_drops = 0;
  uint32_t network_errors = 0;
  uint32_t reconnects = 0;
};

struct RuntimeConfig {
  String ssid;
  String password;
  String target_host;
  uint16_t target_port = STREAMLINE_TARGET_PORT;
  uint8_t input_line = DEFAULT_INPUT_LINE;
  uint8_t input_gain = DEFAULT_INPUT_GAIN;
  uint8_t adc_atten_db = DEFAULT_ADC_ATTEN_DB;
  bool from_defaults = false;
};

struct AudioPacket {
  PacketHeader header;
  StereoSample samples[FRAMES_PER_PACKET];
  uint32_t payload_bytes = 0;
};

QueueHandle_t audio_queue = nullptr;
int stream_socket = -1;
WebServer server(80);
Preferences preferences;
IPAddress target_ip;
RuntimeConfig runtime_config;
uint32_t sequence = 0;
StreamStats stats;
TransportTotals transport_totals;
uint64_t total_clipped_samples = 0;
uint32_t last_report_clipped_samples = 0;
int32_t last_report_peak_left = 0;
int32_t last_report_peak_right = 0;
int32_t last_report_rms_left = 0;
int32_t last_report_rms_right = 0;
bool config_portal_mode = false;
bool web_started = false;
bool diagnostics_enabled = STREAMLINE_DIAGNOSTICS;
bool web_enabled = STREAMLINE_WEB_SERVER;
AudioPacket queue_discard;

void fail_forever(const char *message) {
  Serial.println(message);
  while (true) {
    delay(1000);
  }
}

void fail_if_error(const char *step, esp_err_t err) {
  if (err == ESP_OK) {
    return;
  }

  Serial.printf("ERROR: %s failed: %s\n", step, esp_err_to_name(err));
  while (true) {
    delay(1000);
  }
}

void start_task(TaskFunction_t function, const char *name, UBaseType_t priority) {
  const BaseType_t result = xTaskCreatePinnedToCore(function, name, 8192, nullptr, priority, nullptr, 1);
  if (result != pdPASS) {
    Serial.printf("ERROR: task creation failed name=%s result=%d\n", name, result);
    fail_forever("ERROR: required task creation failed");
  }
}

bool has_network_config() { return runtime_config.ssid.length() > 0 && runtime_config.target_host.length() > 0; }

String normalized_target_host(String host) {
  host.trim();
  return host;
}

bool is_valid_target_host(const String &host) {
  const String normalized = normalized_target_host(host);
  return normalized.length() > 0 && normalized.indexOf(':') < 0 && normalized.indexOf('/') < 0;
}

void record_queue_drop() {
  stats.queue_drops += 1;
  transport_totals.queue_drops += 1;
}

void record_network_error() {
  stats.network_errors += 1;
  transport_totals.network_errors += 1;
}

void record_reconnect() {
  stats.reconnects += 1;
  transport_totals.reconnects += 1;
}

void load_config() {
  preferences.begin("linein", true);
  runtime_config.ssid = preferences.isKey("ssid") ? preferences.getString("ssid", "") : "";
  runtime_config.password = preferences.isKey("pass") ? preferences.getString("pass", "") : "";
  runtime_config.target_host = preferences.isKey("target") ? preferences.getString("target", "") : "";
  runtime_config.target_host = normalized_target_host(runtime_config.target_host);
  runtime_config.target_port =
      preferences.isKey("port") ? preferences.getUShort("port", STREAMLINE_TARGET_PORT) : STREAMLINE_TARGET_PORT;
  runtime_config.input_line =
      preferences.isKey("line") ? preferences.getUChar("line", DEFAULT_INPUT_LINE) : DEFAULT_INPUT_LINE;
  runtime_config.input_gain =
      preferences.isKey("gain") ? preferences.getUChar("gain", DEFAULT_INPUT_GAIN) : DEFAULT_INPUT_GAIN;
  runtime_config.adc_atten_db =
      preferences.isKey("atten") ? preferences.getUChar("atten", DEFAULT_ADC_ATTEN_DB) : DEFAULT_ADC_ATTEN_DB;
  diagnostics_enabled =
      preferences.isKey("diag") ? preferences.getBool("diag", STREAMLINE_DIAGNOSTICS) : STREAMLINE_DIAGNOSTICS;
  web_enabled = preferences.isKey("web") ? preferences.getBool("web", STREAMLINE_WEB_SERVER) : STREAMLINE_WEB_SERVER;
  preferences.end();

  if (has_network_config()) {
    runtime_config.from_defaults = false;
    return;
  }

  runtime_config.ssid = WIFI_SSID;
  runtime_config.password = WIFI_PASSWORD;
  runtime_config.target_host = normalized_target_host(STREAMLINE_TARGET_HOST);
  runtime_config.target_port = STREAMLINE_TARGET_PORT;
  runtime_config.input_line = DEFAULT_INPUT_LINE;
  runtime_config.input_gain = DEFAULT_INPUT_GAIN;
  runtime_config.adc_atten_db = DEFAULT_ADC_ATTEN_DB;
  runtime_config.from_defaults = has_network_config();
}

void save_config(const String &ssid, const String &password, const String &target, uint16_t port, uint8_t line,
                 uint8_t gain, uint8_t atten_db) {
  const String normalized_target = normalized_target_host(target);
  preferences.begin("linein", false);
  preferences.putString("ssid", ssid);
  preferences.putString("pass", password);
  preferences.putString("target", normalized_target);
  preferences.putUShort("port", port);
  preferences.putUChar("line", line);
  preferences.putUChar("gain", gain);
  preferences.putUChar("atten", atten_db);
  preferences.end();
}

void clear_config() {
  preferences.begin("linein", false);
  preferences.clear();
  preferences.end();
}

void save_diagnostics_flag(bool enabled) {
  preferences.begin("linein", false);
  preferences.putBool("diag", enabled);
  preferences.end();
}

void save_web_flag(bool enabled) {
  preferences.begin("linein", false);
  preferences.putBool("web", enabled);
  preferences.end();
}

String config_json() {
  JsonDocument doc;
  doc["ssid"] = runtime_config.ssid;
  doc["target_host"] = runtime_config.target_host;
  doc["target_port"] = runtime_config.target_port;
  doc["input_line"] = runtime_config.input_line;
  doc["input_gain"] = runtime_config.input_gain;
  doc["adc_atten_db"] = runtime_config.adc_atten_db;
  doc["config_source"] = runtime_config.from_defaults ? "local_config_defaults" : "nvs";

  String json;
  serializeJson(doc, json);
  return json;
}

String status_json() {
  JsonDocument doc;
  doc["firmware_version"] = FIRMWARE_VERSION;
  doc["mode"] = config_portal_mode ? "setup-ap" : "streaming";
  doc["config_source"] = runtime_config.from_defaults ? "local_config_defaults" : "nvs";
  doc["web_server"] = web_started;
  doc["configuration_writable"] = config_portal_mode;

  JsonObject wifi = doc["wifi"].to<JsonObject>();
  wifi["ssid"] = runtime_config.ssid;
  wifi["status"] = WiFi.status();
  wifi["sta_ip"] = WiFi.localIP().toString();
  wifi["ap_ip"] = WiFi.softAPIP().toString();
  wifi["rssi"] = WiFi.RSSI();

  JsonObject target_status = doc["target"].to<JsonObject>();
  target_status["target_host"] = runtime_config.target_host;
  target_status["target_port"] = runtime_config.target_port;
  target_status["effective_target_ip"] = target_ip.toString();
  target_status["effective_target_port"] = runtime_config.target_port;
  target_status["transport"] = "tcp-raw-socket";

  JsonObject audio = doc["audio"].to<JsonObject>();
  audio["input_line"] = runtime_config.input_line;
  audio["input_gain"] = runtime_config.input_gain;
  audio["adc_atten_db"] = runtime_config.adc_atten_db;
  audio["sample_rate"] = SAMPLE_RATE;
  audio["channels"] = CHANNELS;
  audio["bits_per_sample"] = BITS_PER_SAMPLE;

  JsonObject metrics = doc["metrics"].to<JsonObject>();
  metrics["sequence"] = sequence;
  metrics["clip_threshold_abs"] = CLIP_THRESHOLD;
  metrics["peak_abs_left"] = last_report_peak_left;
  metrics["peak_abs_right"] = last_report_peak_right;
  metrics["rms_left"] = last_report_rms_left;
  metrics["rms_right"] = last_report_rms_right;
  metrics["free_heap"] = ESP.getFreeHeap();
  metrics["queue_depth"] = stats.queue_depth;
  metrics["queue_drops_last_report"] = stats.queue_drops;
  metrics["queue_drops_total"] = transport_totals.queue_drops;
  metrics["network_errors_last_report"] = stats.network_errors;
  metrics["network_errors_total"] = transport_totals.network_errors;
  metrics["reconnects_last_report"] = stats.reconnects;
  metrics["reconnects_total"] = transport_totals.reconnects;
  metrics["diagnostics"] = diagnostics_enabled;
  if (diagnostics_enabled) {
    metrics["send_ms"] = stats.network_send_us / 1000;
    metrics["blocked_ms"] = stats.network_blocked_us / 1000;
    metrics["send_calls"] = stats.send_calls;
    metrics["send_eagain"] = stats.send_eagain;
  }
  metrics["clipped_samples_current"] = stats.clipped_samples;
  metrics["clipped_samples_last_report"] = last_report_clipped_samples;
  metrics["clipped_samples_total"] = static_cast<unsigned long>(total_clipped_samples);

  String json;
  serializeJson(doc, json);
  return json;
}

void handle_index() { server.send_P(200, "text/html", WEB_INDEX_HTML); }

void restart_after_response() {
  delay(500);
  ESP.restart();
}

void send_json_message(int code, const char *key, const char *message) {
  JsonDocument doc;
  doc[key] = message;
  String body;
  serializeJson(doc, body);
  server.sendHeader("Cache-Control", "no-store");
  server.send(code, "application/json", body);
}

void send_json_ok_rebooting() {
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", "{\"ok\":true,\"rebooting\":true}");
}

void handle_setup_save() {
  if (!config_portal_mode) {
    send_json_message(403, "error", "configuration is writable only in setup mode");
    return;
  }

  const String ssid = server.arg("ssid");
  const String password = server.arg("password").length() > 0 ? server.arg("password") : runtime_config.password;
  const String target = server.arg("target_host");
  const int port = server.arg("target_port").toInt();

  if (ssid.length() == 0 || !is_valid_target_host(target) || port < 1 || port > 65535) {
    send_json_message(400, "error", "ssid, target_host without port, and target_port 1-65535 are required");
    return;
  }

  save_config(ssid, password, target, static_cast<uint16_t>(port), runtime_config.input_line, runtime_config.input_gain,
              runtime_config.adc_atten_db);
  send_json_ok_rebooting();
  restart_after_response();
}

void handle_audio_save() {
  if (!config_portal_mode) {
    send_json_message(403, "error", "configuration is writable only in setup mode");
    return;
  }

  const int line = server.hasArg("line") ? server.arg("line").toInt() : runtime_config.input_line;
  const int gain = server.hasArg("gain") ? server.arg("gain").toInt() : runtime_config.input_gain;
  const int atten = server.hasArg("atten") ? server.arg("atten").toInt() : runtime_config.adc_atten_db;

  if (line < 1 || line > 2 || gain < 0 || gain > 100 || atten < 0 || atten > MAX_ADC_ATTEN_DB) {
    send_json_message(400, "error", "line 1-2, gain 0-100, and attenuation 0-48 are required");
    return;
  }

  save_config(runtime_config.ssid, runtime_config.password, runtime_config.target_host, runtime_config.target_port,
              static_cast<uint8_t>(line), static_cast<uint8_t>(gain), static_cast<uint8_t>(atten));
  send_json_ok_rebooting();
  restart_after_response();
}

void handle_config_reset() {
  if (!config_portal_mode) {
    send_json_message(403, "error", "configuration is writable only in setup mode");
    return;
  }

  clear_config();
  send_json_ok_rebooting();
  restart_after_response();
}

void start_web_server() {
  if (web_started) {
    return;
  }

  server.on("/", HTTP_GET, handle_index);
  server.on("/api/status", HTTP_GET, []() {
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "application/json", status_json());
  });
  server.on("/api/config", HTTP_GET, []() {
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "application/json", config_json());
  });
  server.on("/api/setup", HTTP_POST, handle_setup_save);
  server.on("/api/audio", HTTP_POST, handle_audio_save);
  server.on("/api/reset", HTTP_POST, handle_config_reset);
  server.onNotFound([]() { send_json_message(404, "error", "not found"); });
  server.begin();
  web_started = true;
}

void start_config_portal(const char *reason) {
  config_portal_mode = true;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);

  String ap_name = "esp32-streamline-";
  ap_name += WiFi.macAddress().substring(12);
  ap_name.replace(":", "");

  WiFi.softAP(ap_name.c_str());
  start_web_server();

  Serial.printf("setup_reason=%s\n", reason);
  Serial.printf("setup_ap_ssid=%s\n", ap_name.c_str());
  Serial.printf("setup_url=http://%s/\n", WiFi.softAPIP().toString().c_str());
}

bool connect_wifi() {
  if (!has_network_config()) {
    start_config_portal("missing config");
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(runtime_config.ssid.c_str(), runtime_config.password.c_str());

  Serial.printf("connecting to Wi-Fi SSID=%s", runtime_config.ssid.c_str());
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    server.handleClient();
    delay(500);
    Serial.print(".");
    if (millis() - started > 30000) {
      Serial.println();
      start_config_portal("wifi timeout");
      return false;
    }
  }

  Serial.println();
  Serial.printf("wifi_ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  if (!is_valid_target_host(runtime_config.target_host)) {
    start_config_portal("tcp target invalid");
    return false;
  }

  if (!target_ip.fromString(runtime_config.target_host) &&
      !WiFi.hostByName(runtime_config.target_host.c_str(), target_ip)) {
    start_config_portal("tcp target resolve failed");
    return false;
  }

  Serial.printf("config_url=http://%s/\n", WiFi.localIP().toString().c_str());
  Serial.printf("tcp_target=%s:%d\n", target_ip.toString().c_str(), runtime_config.target_port);
  return true;
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
  config.dma_buf_len = FRAMES_PER_PACKET;
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

input_device_t selected_input(uint8_t input_line) { return input_line == 2 ? ADC_INPUT_LINE2 : ADC_INPUT_LINE1; }

bool set_adc_attenuation(uint8_t atten_db) {
  if (atten_db > MAX_ADC_ATTEN_DB) {
    atten_db = MAX_ADC_ATTEN_DB;
  }
  const uint8_t reg_value = atten_db * 2;
  return es8388_write_reg(ES8388_ADCCONTROL8, reg_value) == RESULT_OK &&
         es8388_write_reg(ES8388_ADCCONTROL9, reg_value) == RESULT_OK;
}

void begin_codec() {
  AudioDriverLogger.begin(Serial, AudioDriverLogLevel::Warning);

  CodecConfig config;
  config.input_device = selected_input(runtime_config.input_line);
  config.output_device = DAC_OUTPUT_NONE;
  config.i2s.bits = BIT_LENGTH_16BITS;
  config.i2s.rate = RATE_48K;
  config.i2s.channels = CHANNELS2;
  config.i2s.fmt = I2S_NORMAL;
  config.i2s.mode = MODE_SLAVE;

  if (!AudioKitEs8388V1.begin(config)) {
    fail_forever("ERROR: AudioKitEs8388V1.begin failed");
  }

  if (!AudioKitEs8388V1.setInputVolume(runtime_config.input_gain)) {
    Serial.println("WARN: setInputVolume failed");
  }

  if (!set_adc_attenuation(runtime_config.adc_atten_db)) {
    Serial.println("WARN: set_adc_attenuation failed");
  }
}

PacketHeader make_header(size_t frames, size_t payload_bytes) {
  PacketHeader header = {};
  memcpy(header.magic, STREAM_MAGIC, sizeof(header.magic));
  header.version = STREAM_VERSION;
  header.header_size = sizeof(PacketHeader);
  header.channels = CHANNELS;
  header.bits_per_sample = BITS_PER_SAMPLE;
  header.sequence = sequence++;
  header.sample_rate = SAMPLE_RATE;
  header.frames = frames;
  header.payload_bytes = payload_bytes;
  return header;
}

AudioPacket make_packet(const StereoSample *buffer, size_t frames) {
  AudioPacket packet = {};
  const size_t payload_bytes = frames * sizeof(StereoSample);
  packet.header = make_header(frames, payload_bytes);
  packet.payload_bytes = payload_bytes;
  memcpy(packet.samples, buffer, payload_bytes);
  return packet;
}

void enqueue_packet(const StereoSample *buffer, size_t frames) {
  if (audio_queue == nullptr) {
    return;
  }

  const AudioPacket packet = make_packet(buffer, frames);
  if (xQueueSend(audio_queue, &packet, 0) != pdTRUE) {
    xQueueReceive(audio_queue, &queue_discard, 0);
    xQueueSend(audio_queue, &packet, 0);
    record_queue_drop();
  }

  stats.queue_depth = uxQueueMessagesWaiting(audio_queue);
}

void close_stream_socket() {
  if (stream_socket >= 0) {
    close(stream_socket);
    stream_socket = -1;
  }
}

bool ensure_stream_connected() {
  if (stream_socket >= 0) {
    return true;
  }

  stream_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
  if (stream_socket < 0) {
    record_network_error();
    return false;
  }

  // Nonblocking connect with an explicit deadline. SO_SNDTIMEO only bounds
  // send(); a blocking connect() can wait through TCP SYN retries (seconds)
  // when the bridge is unreachable, stalling the network task and letting the
  // capture queue overflow. Use nonblocking connect + select + SO_ERROR.
  const int flags = fcntl(stream_socket, F_GETFL, 0);
  if (flags < 0 || fcntl(stream_socket, F_SETFL, flags | O_NONBLOCK) != 0) {
    record_network_error();
    close_stream_socket();
    return false;
  }

  sockaddr_in dest = {};
  dest.sin_family = AF_INET;
  dest.sin_port = htons(runtime_config.target_port);
  dest.sin_addr.s_addr = static_cast<uint32_t>(target_ip);

  const int rc = connect(stream_socket, reinterpret_cast<sockaddr *>(&dest), sizeof(dest));
  if (rc != 0 && errno != EINPROGRESS) {
    record_network_error();
    close_stream_socket();
    return false;
  }

  fd_set write_fds;
  FD_ZERO(&write_fds);
  FD_SET(stream_socket, &write_fds);
  timeval deadline = {};
  deadline.tv_sec = TCP_CONNECT_TIMEOUT_MS / 1000;
  deadline.tv_usec = (TCP_CONNECT_TIMEOUT_MS % 1000) * 1000;

  const int sel = select(stream_socket + 1, nullptr, &write_fds, nullptr, &deadline);
  if (sel <= 0) {
    record_network_error();
    close_stream_socket();
    return false;
  }

  int sock_err = 0;
  socklen_t sock_err_len = sizeof(sock_err);
  if (getsockopt(stream_socket, SOL_SOCKET, SO_ERROR, &sock_err, &sock_err_len) != 0 || sock_err != 0) {
    record_network_error();
    close_stream_socket();
    return false;
  }

  // Restore blocking mode and apply send-side options for the send() path.
  if (fcntl(stream_socket, F_SETFL, flags) != 0) {
    record_network_error();
    close_stream_socket();
    return false;
  }

  const int one = 1;
  setsockopt(stream_socket, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

  timeval timeout = {};
  timeout.tv_sec = TCP_SEND_TIMEOUT_MS / 1000;
  timeout.tv_usec = (TCP_SEND_TIMEOUT_MS % 1000) * 1000;
  setsockopt(stream_socket, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));

  record_reconnect();
  Serial.printf("tcp_connected=%s:%d\n", target_ip.toString().c_str(), runtime_config.target_port);
  return true;
}

bool send_all(const uint8_t *data, size_t size) {
  size_t sent = 0;
  uint32_t stalled_since = 0;
  while (sent < size) {
    size_t remaining = size - sent;
    if (remaining > TCP_SEND_CHUNK_BYTES) {
      remaining = TCP_SEND_CHUNK_BYTES;
    }

    stats.send_calls += 1;
    const int rc = send(stream_socket, data + sent, remaining, 0);
    if (rc > 0) {
      sent += static_cast<size_t>(rc);
      stalled_since = 0;
      continue;
    }

    if (rc < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
      stats.send_eagain += 1;
      if (stalled_since == 0) {
        stalled_since = millis();
      } else if (millis() - stalled_since > static_cast<uint32_t>(TCP_SEND_TIMEOUT_MS)) {
        record_network_error();
        close_stream_socket();
        return false;
      }
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }

    record_network_error();
    close_stream_socket();
    return false;
  }

  return true;
}

bool send_packet_tcp(const AudioPacket &packet) {
  if (!ensure_stream_connected()) {
    return false;
  }

  // Coalesce header + payload into a single send() so TCP_NODELAY produces one
  // TCP segment per audio packet instead of one tiny header segment plus one
  // payload segment. Two send() calls per packet roughly doubled per-segment
  // WiFi/lwIP TX overhead and capped throughput at ~140 pkt/s.
  const size_t total = sizeof(packet.header) + packet.payload_bytes;
  uint8_t out[sizeof(packet.header) + FRAMES_PER_PACKET * sizeof(StereoSample)];
  memcpy(out, &packet.header, sizeof(packet.header));
  memcpy(out + sizeof(packet.header), packet.samples, packet.payload_bytes);

  if (!send_all(out, total)) {
    return false;
  }

  stats.packets += 1;
  stats.bytes += packet.payload_bytes;
  return true;
}

int32_t sample_abs(int16_t sample) { return sample == INT16_MIN ? 32768 : abs(sample); }

void update_audio_stats(const StereoSample *buffer, size_t frames) {
  stats.frames_processed += frames;
  for (size_t i = 0; i < frames; i++) {
    const int32_t left_abs = sample_abs(buffer[i].left);
    const int32_t right_abs = sample_abs(buffer[i].right);
    if (left_abs > stats.peak_abs_left) stats.peak_abs_left = left_abs;
    if (right_abs > stats.peak_abs_right) stats.peak_abs_right = right_abs;
    stats.sum_abs_left += left_abs;
    stats.sum_abs_right += right_abs;
    if (left_abs >= CLIP_THRESHOLD) {
      stats.clipped_samples += 1;
      total_clipped_samples += 1;
    }
    if (right_abs >= CLIP_THRESHOLD) {
      stats.clipped_samples += 1;
      total_clipped_samples += 1;
    }
  }
}

void maybe_report() {
  const uint32_t now = millis();
  if (stats.last_report_ms == 0) {
    stats.last_report_ms = now;
  }
  if (now - stats.last_report_ms < SERIAL_REPORT_MS) {
    return;
  }

  last_report_clipped_samples = stats.clipped_samples;
  last_report_peak_left = stats.peak_abs_left;
  last_report_peak_right = stats.peak_abs_right;
  last_report_rms_left = stats.frames_processed > 0 ? stats.sum_abs_left / stats.frames_processed : 0;
  last_report_rms_right = stats.frames_processed > 0 ? stats.sum_abs_right / stats.frames_processed : 0;

  if (diagnostics_enabled) {
    Serial.printf(
        "packets=%u send_ms=%u blocked_ms=%u calls=%u eagain=%u peak_L=%d peak_R=%d rms_L=%d rms_R=%d clips=%u heap=%u "
        "rssi=%d\n",
        stats.packets, stats.network_send_us / 1000, stats.network_blocked_us / 1000, stats.send_calls,
        stats.send_eagain, last_report_peak_left, last_report_peak_right, last_report_rms_left, last_report_rms_right,
        stats.clipped_samples, ESP.getFreeHeap(), WiFi.RSSI());
  } else {
    Serial.printf("packets=%u peak_L=%d peak_R=%d rms_L=%d rms_R=%d clips=%u heap=%u rssi=%d\n", stats.packets,
                  last_report_peak_left, last_report_peak_right, last_report_rms_left, last_report_rms_right,
                  stats.clipped_samples, ESP.getFreeHeap(), WiFi.RSSI());
  }

  // Transport health: always print in diagnostics mode; otherwise surface only
  // when something is nonzero so a healthy stream stays quiet on serial.
  if (diagnostics_enabled || stats.queue_drops > 0 || stats.network_errors > 0 || stats.reconnects > 0) {
    Serial.printf("queue_depth=%u queue_drops=%u network_errors=%u reconnects=%u\n", stats.queue_depth,
                  stats.queue_drops, stats.network_errors, stats.reconnects);
  }

  stats = {};
  stats.last_report_ms = now;
}

void capture_task(void *) {
  StereoSample capture_samples[FRAMES_PER_PACKET];

  while (true) {
    size_t bytes_read = 0;
    const esp_err_t err =
        i2s_read(I2S_PORT, capture_samples, sizeof(capture_samples), &bytes_read, pdMS_TO_TICKS(1000));

    if (err != ESP_OK) {
      stats.read_errors += 1;
      Serial.printf("ERROR: i2s_read failed: %s\n", esp_err_to_name(err));
      delay(100);
      continue;
    }

    const size_t frames = bytes_read / sizeof(StereoSample);
    if (frames == 0) {
      stats.short_reads += 1;
      maybe_report();
      continue;
    }

    if (bytes_read != sizeof(capture_samples)) {
      stats.short_reads += 1;
    }

    update_audio_stats(capture_samples, frames);
    enqueue_packet(capture_samples, frames);
    maybe_report();
  }
}

void network_task(void *) {
  AudioPacket packet;

  while (true) {
    const int64_t recv_start = esp_timer_get_time();
    if (audio_queue == nullptr || xQueueReceive(audio_queue, &packet, portMAX_DELAY) != pdTRUE) {
      continue;
    }
    stats.network_blocked_us += static_cast<uint32_t>(esp_timer_get_time() - recv_start);

    stats.queue_depth = uxQueueMessagesWaiting(audio_queue);
    const uint32_t drops_before_send = transport_totals.queue_drops;

    const int64_t send_start = esp_timer_get_time();
    while (WiFi.status() != WL_CONNECTED || !send_packet_tcp(packet)) {
      if (transport_totals.queue_drops != drops_before_send) {
        break;
      }
      vTaskDelay(NETWORK_RETRY_TICKS);
    }
    stats.network_send_us += static_cast<uint32_t>(esp_timer_get_time() - send_start);
  }
}

}  // namespace

void handle_serial_commands() {
  static String line;
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') {
      continue;
    }
    if (c != '\n') {
      line += c;
      if (line.length() > 32) {
        line = "";
      }
      continue;
    }

    line.trim();
    line.toLowerCase();
    if (line == "diag") {
      diagnostics_enabled = !diagnostics_enabled;
      save_diagnostics_flag(diagnostics_enabled);
      Serial.printf("diagnostics=%s\n", diagnostics_enabled ? "on" : "off");
    } else if (line == "web") {
      web_enabled = !web_enabled;
      save_web_flag(web_enabled);
      if (web_enabled && !web_started) {
        start_web_server();
      }
      Serial.printf("web_server=%s (takes full effect after reboot)\n", web_enabled ? "on" : "off");
    } else if (line == "setup") {
      close_stream_socket();
      start_config_portal("serial command");
    } else if (line == "status") {
      Serial.printf("mode=%s diagnostics=%s web=%s wifi=%d heap=%u rssi=%d queue_depth=%u queue_drops=%u\n",
                    config_portal_mode ? "setup-ap" : "streaming", diagnostics_enabled ? "on" : "off",
                    web_started ? "on" : "off", static_cast<int>(WiFi.status()),
                    static_cast<unsigned>(ESP.getFreeHeap()), WiFi.RSSI(), stats.queue_depth, stats.queue_drops);
    } else if (line == "help") {
      Serial.println(
          "commands: diag (toggle diagnostics), web (toggle web server), setup (start setup AP), status, help");
    } else if (line.length() > 0) {
      Serial.printf("unknown command '%s' (try: help)\n", line.c_str());
    }
    line = "";
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  load_config();

  Serial.println();
  Serial.printf("ESP32 StreamLine v%s TCP raw socket streamer\n", FIRMWARE_VERSION);
  Serial.printf(
      "sample_rate=%d channels=%d bits=%d frames_per_packet=%u input_line=%d input_gain=%d adc_atten_db=%d "
      "diagnostics=%s web=%s\n",
      SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE, static_cast<unsigned>(FRAMES_PER_PACKET), runtime_config.input_line,
      runtime_config.input_gain, runtime_config.adc_atten_db, diagnostics_enabled ? "on" : "off",
      web_enabled ? "on" : "off");
  Serial.println(
      "serial commands: diag (toggle diagnostics), web (toggle web server), setup (start setup AP), status, help");

  if (!connect_wifi()) {
    return;
  }
  if (web_enabled) {
    start_web_server();
  }
  begin_i2s();
  begin_codec();
  Serial.printf("free_heap_before_queue=%u\n", static_cast<unsigned>(ESP.getFreeHeap()));
  audio_queue = xQueueCreate(AUDIO_QUEUE_DEPTH, sizeof(AudioPacket));
  if (audio_queue == nullptr) {
    Serial.printf("ERROR: audio queue allocation failed requested=%u item_size=%u free_heap=%u\n",
                  static_cast<unsigned>(AUDIO_QUEUE_DEPTH), static_cast<unsigned>(sizeof(AudioPacket)),
                  static_cast<unsigned>(ESP.getFreeHeap()));
    fail_forever("ERROR: audio queue allocation failed");
  }
  start_task(capture_task, "capture", 3);
  // network_task runs on core 1, away from the lwIP tcpip thread (pinned to
  // core 0 via CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0). Pinning both on core 0
  // serialized "hand bytes to lwIP" with "lwIP hands bytes to WiFi" and capped
  // throughput at ~140 pkt/s. Capture also runs on core 1 at priority 3 but is
  // blocked on i2s_read for ~5ms per packet, leaving slack for sends between
  // captures.
  start_task(network_task, "network", 2);
  Serial.printf("tcp streaming started queue_depth=%u\n", static_cast<unsigned>(AUDIO_QUEUE_DEPTH));
}

void loop() {
  handle_serial_commands();

  if (web_started) {
    server.handleClient();
  }

  if (config_portal_mode) {
    delay(5);
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WARN: Wi-Fi disconnected; reconnecting");
    close_stream_socket();
    if (!connect_wifi()) {
      return;
    }
  }

  delay(50);
}
