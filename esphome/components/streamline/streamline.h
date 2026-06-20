#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "esphome/components/microphone/microphone.h"
#include "esphome/core/component.h"

struct QueueDefinition;
typedef struct QueueDefinition *QueueHandle_t;

namespace esphome::streamline {

class StreamLine : public Component {
public:
  void set_microphone(microphone::Microphone *microphone) {
    this->microphone_ = microphone;
  }
  void set_target_host(const std::string &host) { this->target_host_ = host; }
  void set_target_port(uint16_t port) { this->target_port_ = port; }
  void set_swap_stereo(bool swap_stereo) { this->swap_stereo_ = swap_stereo; }

  void setup() override;
  void dump_config() override;
  float get_setup_priority() const override;
  void on_shutdown() override;

protected:
  static constexpr size_t FRAMES_PER_PACKET = 256;
  static constexpr size_t FRAME_BYTES = 4;
  static constexpr size_t PAYLOAD_BYTES = FRAMES_PER_PACKET * FRAME_BYTES;
  static constexpr size_t QUEUE_DEPTH = 32;

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

  struct __attribute__((packed)) AudioPacket {
    PacketHeader header;
    uint8_t payload[PAYLOAD_BYTES];
  };

  static_assert(sizeof(PacketHeader) == 24, "ELI1 header must be 24 bytes");
  static_assert(sizeof(AudioPacket) == 24 + PAYLOAD_BYTES,
                "ELI1 packet layout changed");

  static void network_task_(void *parameter);
  void run_network_task_();
  void on_microphone_data_(const std::vector<uint8_t> &data);
  void enqueue_packet_();
  bool send_packet_(const AudioPacket &packet);
  bool connect_();
  void close_socket_();

  microphone::Microphone *microphone_{nullptr};
  std::string target_host_;
  uint16_t target_port_{39000};
  bool swap_stereo_{true};
  bool stopping_{false};
  QueueHandle_t queue_{nullptr};
  int socket_{-1};
  uint8_t ingress_[PAYLOAD_BYTES]{};
  size_t ingress_size_{0};
  uint32_t sequence_{0};
  uint32_t queue_drops_{0};
  uint32_t network_errors_{0};
  uint32_t reconnects_{0};
};

} // namespace esphome::streamline
