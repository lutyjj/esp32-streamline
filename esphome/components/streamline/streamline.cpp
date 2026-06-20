#include "streamline.h"

#ifdef USE_ESP32

#include <algorithm>
#include <cerrno>
#include <cstring>

#include <fcntl.h>
#include <lwip/inet.h>
#include <lwip/netdb.h>
#include <lwip/sockets.h>
#include <lwip/tcp.h>

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include "esphome/core/hal.h"
#include "esphome/core/log.h"

namespace esphome::streamline {

namespace {

constexpr const char *const TAG = "streamline";
constexpr uint32_t SAMPLE_RATE = 48000;
constexpr TickType_t NETWORK_RETRY_TICKS = pdMS_TO_TICKS(250);
constexpr int TCP_TIMEOUT_MS = 250;
constexpr UBaseType_t NETWORK_TASK_PRIORITY = 18;
constexpr uint32_t NETWORK_TASK_STACK_BYTES = 8192;

} // namespace

void StreamLine::setup() {
  if (this->microphone_ == nullptr || this->target_host_.empty()) {
    ESP_LOGE(TAG, "microphone_id and target_host are required");
    this->mark_failed();
    return;
  }

  this->queue_ = xQueueCreate(QUEUE_DEPTH, sizeof(AudioPacket));
  if (this->queue_ == nullptr) {
    ESP_LOGE(TAG, "cannot allocate %u-packet transport queue", QUEUE_DEPTH);
    this->mark_failed();
    return;
  }

  this->microphone_->add_data_callback(
      [this](const std::vector<uint8_t> &data) {
        this->on_microphone_data_(data);
      });
  this->microphone_->start();

  if (xTaskCreatePinnedToCore(StreamLine::network_task_, "streamline_tcp",
                              NETWORK_TASK_STACK_BYTES, this,
                              NETWORK_TASK_PRIORITY, nullptr, 1) != pdPASS) {
    ESP_LOGE(TAG, "cannot start TCP transport task");
    this->mark_failed();
    return;
  }
}

float StreamLine::get_setup_priority() const { return setup_priority::LATE; }

void StreamLine::dump_config() {
  ESP_LOGCONFIG(TAG, "StreamLine ELI1 transport:");
  ESP_LOGCONFIG(TAG, "  Target: %s:%u", this->target_host_.c_str(),
                this->target_port_);
  ESP_LOGCONFIG(TAG, "  Format: 48000 Hz, 16-bit stereo PCM");
  ESP_LOGCONFIG(TAG, "  Queue depth: %u packets", QUEUE_DEPTH);
  ESP_LOGCONFIG(TAG, "  Swap ESPHome stereo samples: %s",
                YESNO(this->swap_stereo_));
}

void StreamLine::on_shutdown() { this->stopping_ = true; }

void StreamLine::on_microphone_data_(const std::vector<uint8_t> &data) {
  // ESPHome invokes this from its I2S capture task. This path must remain
  // bounded and non-blocking: it only packetizes/copies into a fixed queue.
  size_t offset = 0;
  while (offset < data.size()) {
    const size_t copied =
        std::min(PAYLOAD_BYTES - this->ingress_size_, data.size() - offset);
    memcpy(&this->ingress_[this->ingress_size_], &data[offset], copied);
    this->ingress_size_ += copied;
    offset += copied;

    if (this->ingress_size_ == PAYLOAD_BYTES) {
      this->enqueue_packet_();
      this->ingress_size_ = 0;
    }
  }
}

void StreamLine::enqueue_packet_() {
  AudioPacket packet{};
  memcpy(packet.header.magic, "ELI1", 4);
  packet.header.version = 1;
  packet.header.header_size = sizeof(PacketHeader);
  packet.header.channels = 2;
  packet.header.bits_per_sample = 16;
  packet.header.sequence = this->sequence_++;
  packet.header.sample_rate = SAMPLE_RATE;
  packet.header.frames = FRAMES_PER_PACKET;
  packet.header.payload_bytes = PAYLOAD_BYTES;

  if (this->swap_stereo_) {
    for (size_t frame = 0; frame < FRAMES_PER_PACKET; frame++) {
      const size_t offset = frame * FRAME_BYTES;
      memcpy(&packet.payload[offset], &this->ingress_[offset + 2], 2);
      memcpy(&packet.payload[offset + 2], &this->ingress_[offset], 2);
    }
  } else {
    memcpy(packet.payload, this->ingress_, PAYLOAD_BYTES);
  }

  if (xQueueSend(this->queue_, &packet, 0) == pdPASS)
    return;

  AudioPacket discarded{};
  if (xQueueReceive(this->queue_, &discarded, 0) == pdPASS &&
      xQueueSend(this->queue_, &packet, 0) == pdPASS) {
    this->queue_drops_++;
    return;
  }
  // The only consumer is the TCP worker. A failed discard/send indicates an
  // unexpected queue state; drop this newest packet rather than blocking I2S.
  this->queue_drops_++;
}

void StreamLine::network_task_(void *parameter) {
  static_cast<StreamLine *>(parameter)->run_network_task_();
}

void StreamLine::run_network_task_() {
  uint32_t last_stats = millis();
  while (!this->stopping_) {
    const uint32_t now = millis();
    if (now - last_stats >= 5000) {
      last_stats = now;
      ESP_LOGI(TAG, "stats: queue=%u/%u drops=%u net_errors=%u reconnects=%u",
               static_cast<unsigned>(uxQueueMessagesWaiting(this->queue_)), QUEUE_DEPTH,
               this->queue_drops_, this->network_errors_, this->reconnects_);
    }

    AudioPacket packet{};
    if (xQueueReceive(this->queue_, &packet, pdMS_TO_TICKS(100)) != pdPASS)
      continue;

    while (!this->stopping_ && !this->send_packet_(packet)) {
      this->network_errors_++;
      vTaskDelay(NETWORK_RETRY_TICKS);
    }
  }
  vTaskDelete(nullptr);
}

bool StreamLine::send_packet_(const AudioPacket &packet) {
  if (this->socket_ < 0 && !this->connect_())
    return false;

  const uint8_t *bytes = reinterpret_cast<const uint8_t *>(&packet);
  size_t remaining = sizeof(packet);
  while (remaining > 0) {
    const int sent = send(this->socket_, bytes, remaining, 0);
    if (sent <= 0) {
      ESP_LOGW(TAG, "TCP send failed: errno=%d", errno);
      this->close_socket_();
      return false;
    }
    bytes += sent;
    remaining -= sent;
  }
  return true;
}

bool StreamLine::connect_() {
  addrinfo hints{};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;

  addrinfo *result = nullptr;
  const std::string port = std::to_string(this->target_port_);
  const int lookup =
      getaddrinfo(this->target_host_.c_str(), port.c_str(), &hints, &result);
  if (lookup != 0 || result == nullptr) {
    ESP_LOGW(TAG, "DNS lookup for %s failed: %d", this->target_host_.c_str(),
             lookup);
    return false;
  }

  const int socket_fd =
      socket(result->ai_family, result->ai_socktype, result->ai_protocol);
  if (socket_fd < 0) {
    ESP_LOGW(TAG, "TCP socket creation failed: errno=%d", errno);
    freeaddrinfo(result);
    return false;
  }

  const int flags = fcntl(socket_fd, F_GETFL, 0);
  if (flags < 0 || fcntl(socket_fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    ESP_LOGW(TAG, "cannot configure non-blocking TCP socket: errno=%d", errno);
    close(socket_fd);
    freeaddrinfo(result);
    return false;
  }

  int connect_result = connect(socket_fd, result->ai_addr, result->ai_addrlen);
  freeaddrinfo(result);
  if (connect_result < 0 && errno == EINPROGRESS) {
    fd_set writable{};
    FD_ZERO(&writable);
    FD_SET(socket_fd, &writable);
    timeval timeout{.tv_sec = 0, .tv_usec = TCP_TIMEOUT_MS * 1000};
    connect_result =
        select(socket_fd + 1, nullptr, &writable, nullptr, &timeout);
    int socket_error = 0;
    socklen_t socket_error_size = sizeof(socket_error);
    if (connect_result != 1 ||
        getsockopt(socket_fd, SOL_SOCKET, SO_ERROR, &socket_error,
                   &socket_error_size) != 0 ||
        socket_error != 0) {
      ESP_LOGW(TAG, "TCP connect to %s:%u failed", this->target_host_.c_str(),
               this->target_port_);
      close(socket_fd);
      return false;
    }
  } else if (connect_result < 0) {
    ESP_LOGW(TAG, "TCP connect to %s:%u failed: errno=%d",
             this->target_host_.c_str(), this->target_port_, errno);
    close(socket_fd);
    return false;
  }

  if (fcntl(socket_fd, F_SETFL, flags) < 0) {
    close(socket_fd);
    return false;
  }
  const int enabled = 1;
  const timeval timeout{.tv_sec = 0, .tv_usec = TCP_TIMEOUT_MS * 1000};
  setsockopt(socket_fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
  setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  this->socket_ = socket_fd;
  this->reconnects_++;
  ESP_LOGI(TAG, "connected to %s:%u", this->target_host_.c_str(),
           this->target_port_);
  return true;
}

void StreamLine::close_socket_() {
  if (this->socket_ >= 0) {
    shutdown(this->socket_, SHUT_RDWR);
    close(this->socket_);
    this->socket_ = -1;
  }
}

} // namespace esphome::streamline

#endif // USE_ESP32
