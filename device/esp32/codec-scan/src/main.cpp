#include <Arduino.h>
#include <Wire.h>

struct I2CPins {
  const char *name;
  int sda;
  int scl;
};

static constexpr I2CPins PIN_SETS[] = {
    {"Audio Kit primary", 33, 32},
    {"ESP32 common default", 21, 22},
    {"Audio Kit alternate", 18, 23},
};

static const char *known_device(uint8_t address) {
  switch (address) {
    case 0x10:
      return "ES8388 candidate";
    case 0x1A:
      return "AC101 candidate";
    default:
      return "";
  }
}

static void scan_bus(const I2CPins &pins) {
  Serial.printf("\nScanning %s: SDA=%d SCL=%d\n", pins.name, pins.sda, pins.scl);
  Wire.end();
  Wire.begin(pins.sda, pins.scl, 100000);
  delay(50);

  int found = 0;
  for (uint8_t address = 1; address < 127; ++address) {
    Wire.beginTransmission(address);
    const uint8_t result = Wire.endTransmission();
    if (result == 0) {
      ++found;
      Serial.printf("  found 0x%02X %s\n", address, known_device(address));
    }
  }

  if (found == 0) {
    Serial.println("  no I2C devices found");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println("\nESP32 Audio Kit codec scanner");
}

void loop() {
  for (const auto &pins : PIN_SETS) {
    scan_bus(pins);
  }

  Serial.println("\nScan complete; repeating in 5 seconds.");
  delay(5000);
}
