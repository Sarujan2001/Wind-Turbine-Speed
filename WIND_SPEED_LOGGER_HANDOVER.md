# WIND SPEED LOGGER — PROJECT / CODE HANDOVER
**Status date:** 20 Aug 2026  
**Project:** SPL Wind Speed Logger / Wind Turbine Site Test  
**Controller:** Seeed Studio XIAO ESP32-C3  
**Sensor:** DFRobot SEN0170 Anemometer, 0–5 V output, 0–30 m/s

---

## 1. CURRENT PROJECT STATUS

The custom PCB has arrived and the initial electrical checks have passed.

### Completed
- Bare PCB continuity checks: PASS
- +12 V to GND short check: PASS — OL / no beep
- WIND_RAW to GND short check: PASS — OL / no beep
- WIND_ADC to GND short check: PASS — OL / no beep
- R1 = 20 kΩ soldered
- R2 = 10 kΩ soldered
- C1 = 100 nF soldered
- Resistance checks after soldering: PASS
- Powered PCB test without sensor and without ESP32: PASS
- Approx. +12 V rail measured at J1/J2 during test: 11.91 V
- KiCad DC SPICE divider simulation: PASS
- KiCad transient simulation setup completed

### Not connected yet
- SEN0170 wind sensor
- XIAO ESP32-C3

The next stage is to connect the SEN0170 when it arrives, measure WIND_RAW and WIND_ADC with a multimeter, and only then connect the ESP32 ADC.

---

## 2. FINAL PCB ELECTRICAL ARRANGEMENT

### J1 — 12 V Input
| Pin | Function |
|---|---|
| J1 Pin 1 | +12 V |
| J1 Pin 2 | GND |

### J2 — SEN0170 Sensor Connector
| Pin | Function |
|---|---|
| J2 Pin 1 | +12 V to sensor |
| J2 Pin 2 | GND |
| J2 Pin 3 | WIND_RAW / sensor 0–5 V output |
| J2 Pin 4 | NC |

### Signal-conditioning circuit

```text
SEN0170 SIGNAL / WIND_RAW
          |
       R1 = 20k
          |
          +---------- WIND_ADC ----------> XIAO A1 / GPIO3
          |
       R2 = 10k
          |
         GND

C1 = 100 nF from WIND_ADC to GND
```

### Important
The XIAO ESP32-C3 is **NOT powered from 12 V**.

Use:
- 12 V for the SEN0170
- USB / suitable 5 V supply for the XIAO
- Common GND between sensor/PCB/XIAO

**Never connect 12 V directly to the XIAO.**

---

## 3. VOLTAGE DIVIDER

R1 = 20 kΩ  
R2 = 10 kΩ

The divider ratio is:

```text
WIND_ADC = WIND_RAW × 1/3
```

Expected readings:

| WIND_RAW | WIND_ADC |
|---:|---:|
| 0.0 V | 0.000 V |
| 0.5 V | 0.167 V |
| 1.0 V | 0.333 V |
| 2.0 V | 0.667 V |
| 3.0 V | 1.000 V |
| 4.0 V | 1.333 V |
| 5.0 V | 1.667 V |

Maximum normal sensor output:
```text
5.0 V sensor output -> about 1.667 V at ESP32 ADC
```

Do NOT substitute R1 = 2 kΩ for 20 kΩ.  
With 2 kΩ / 10 kΩ, 5 V would produce about 4.17 V at the ADC, which is unsafe for the ESP32 input.

---

## 4. SENSOR CONVERSION

SEN0170 range used for this project:

```text
0 V -> 0 m/s
5 V -> 30 m/s
```

Therefore:

```text
Wind speed (m/s) = Sensor voltage × 6
```

Since the PCB divides the sensor voltage by 3:

```text
Sensor voltage = WIND_ADC × 3
```

Therefore directly from ADC-node voltage:

```text
Wind speed (m/s) = WIND_ADC voltage × 18
```

And:

```text
Wind speed (km/h) = Wind speed (m/s) × 3.6
```

---

## 5. XIAO ESP32-C3 ADC PIN

Current project mapping:

```text
WIND_ADC -> XIAO A1 / GPIO3
```

The PCB routes WIND_ADC to the XIAO/header ADC connection.

Before connecting the XIAO:
1. Connect the SEN0170.
2. Power the sensor from 12 V.
3. Measure J2 Pin 3 / WIND_RAW.
4. Measure WIND_ADC.
5. Confirm WIND_ADC is approximately WIND_RAW / 3.
6. Confirm WIND_ADC is safely below the ESP32 ADC limit.
7. Then install/connect the XIAO.

---

## 6. ESP32 TEST FIRMWARE

```cpp
// SPL Wind Speed Logger
// Seeed Studio XIAO ESP32-C3
// SEN0170 -> PCB divider -> A1 / GPIO3

const int WIND_ADC_PIN = A1;

const float ADC_REFERENCE = 3.3f;
const int ADC_MAX = 4095;

const float DIVIDER_MULTIPLIER = 3.0f;  // 20k / 10k divider
const float MS_PER_SENSOR_VOLT = 6.0f;  // SEN0170: 0-5V -> 0-30m/s

void setup() {
  Serial.begin(115200);

  analogReadResolution(12);

  delay(1000);

  Serial.println("SPL Wind Speed Logger");
  Serial.println("---------------------");
}

void loop() {
  int adcRaw = analogRead(WIND_ADC_PIN);

  float windAdcVoltage =
      ((float)adcRaw / ADC_MAX) * ADC_REFERENCE;

  float sensorVoltage =
      windAdcVoltage * DIVIDER_MULTIPLIER;

  // Clamp calculated sensor voltage to expected SEN0170 range
  if (sensorVoltage < 0.0f) sensorVoltage = 0.0f;
  if (sensorVoltage > 5.0f) sensorVoltage = 5.0f;

  float windSpeedMS =
      sensorVoltage * MS_PER_SENSOR_VOLT;

  float windSpeedKMH =
      windSpeedMS * 3.6f;

  Serial.print("ADC=");
  Serial.print(adcRaw);

  Serial.print(" | WIND_ADC=");
  Serial.print(windAdcVoltage, 3);
  Serial.print("V");

  Serial.print(" | SENSOR=");
  Serial.print(sensorVoltage, 3);
  Serial.print("V");

  Serial.print(" | WIND=");
  Serial.print(windSpeedMS, 2);
  Serial.print("m/s");

  Serial.print(" | ");
  Serial.print(windSpeedKMH, 1);
  Serial.println("km/h");

  delay(500);
}
```

Example previously used in simulation:

```text
ADC=227 | WIND_ADC=0.277V | SENSOR=0.832V | WIND=4.99m/s | 18.0km/h
```

---

## 7. KICAD SPICE RESULTS

### DC sweep
The final 20 kΩ / 10 kΩ divider was simulated using a 0–5 V input.

Result:
```text
WIND_RAW = 5.0 V
WIND_ADC ≈ 1.667 V
```

This matched the intended 1/3 divider ratio.

### RC filter
C1 = 100 nF is connected from WIND_ADC to GND.

Approximate effective resistance seen by the capacitor:

```text
R1 || R2 ≈ 6.67 kΩ
```

Approximate RC time constant:

```text
τ ≈ 0.667 ms
```

Approximate cutoff frequency:

```text
fc ≈ 239 Hz
```

---

## 8. PHYSICAL PCB TEST RESULTS COMPLETED

Before parts were fitted, continuity readings on intended connected traces were approximately 1.4–2.1 Ω. The meter leads themselves measured about 2.3 Ω when shorted together, so these trace readings were treated as good continuity.

Critical isolation tests:
```text
+12 V -> GND       = OL / no beep
WIND_RAW -> GND    = OL / no beep
WIND_ADC -> GND    = OL / no beep
```

After R1/R2/C1 were soldered:
```text
R1 path ≈ 20 kΩ         PASS
R2 path ≈ 10 kΩ         PASS
R1 + R2 path ≈ 30 kΩ    PASS
No +12 V/GND short      PASS
```

Powered test without sensor/ESP32:
```text
J2 sensor +12 V rail ≈ 11.91 V
GND-to-GND ≈ 0 V
WIND_RAW ≈ 0 V with no sensor
WIND_ADC ≈ 0 V with no sensor
```

---

## 9. NEXT STEPS WHEN SEN0170 ARRIVES

### Stage A — Sensor power test
Do NOT connect ESP32 yet.

Connect:
```text
J2 Pin 1 -> SEN0170 +V
J2 Pin 2 -> SEN0170 GND
J2 Pin 3 -> SEN0170 signal
```

Power J1 with the 12 V supply.

Multimeter in DC-voltage mode:

```text
BLACK probe -> GND
RED probe   -> J2 Pin 1
Expected    -> around 12 V
```

### Stage B — Measure sensor output

```text
BLACK -> GND
RED   -> J2 Pin 3 / WIND_RAW
```

Record the voltage.

### Stage C — Measure divided ADC signal

```text
BLACK -> GND
RED   -> WIND_ADC
```

Check:

```text
WIND_ADC ≈ WIND_RAW / 3
```

Examples:
```text
WIND_RAW 3.0 V -> WIND_ADC about 1.0 V
WIND_RAW 5.0 V -> WIND_ADC about 1.67 V
```

### Stage D — Connect XIAO

Only after the multimeter readings are correct:

```text
WIND_ADC -> XIAO A1 / GPIO3
GND      -> XIAO GND
```

Power the XIAO from USB / suitable 5 V, not from the PCB's 12 V rail.

Upload the firmware and compare:
- multimeter WIND_ADC
- firmware WIND_ADC
- calculated sensor voltage
- calculated wind speed

---

## 10. SAFETY / DEBUG RULES

- Never put 12 V into WIND_RAW.
- Never put 12 V into WIND_ADC.
- Never put 12 V directly into the XIAO.
- Never measure current by placing a multimeter in A-mode directly across +12 V and GND.
- Current measurements must be made with the meter in series.
- Resistance/continuity tests must only be performed with power disconnected.
- If +12 V to GND gives a solid continuity beep, stop and do not power the PCB.
- If WIND_ADC is unexpectedly above about 1.7 V with a normal 0–5 V SEN0170 signal, disconnect the ESP32 and debug the divider first.

---

## 11. PROJECT STATE FOR NEXT CHAT / ENGINEER

The custom PCB is physically available and has passed initial bare-board, soldered-passive, and 12 V rail checks. R1=20 kΩ, R2=10 kΩ and C1=100 nF are installed. The SEN0170 and XIAO have not yet been connected to the finished PCB. The immediate task is to connect the SEN0170, verify WIND_RAW and WIND_ADC with a multimeter, and then connect/program the XIAO ESP32-C3.

Do not redesign the divider unless a new sensor/output range is chosen.
