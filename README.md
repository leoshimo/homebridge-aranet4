# Homebridge Aranet4

A Homebridge platform plugin for [Aranet4](https://aranet.com/products/aranet4-home) CO2 sensors.

This fork keeps the original `Aranet4` platform alias and adds explicit multi-device enrollment. It is intended for setups where Homebridge should manage only known Aranet4 sensors instead of automatically adding whichever Bluetooth device is discovered first.

## Features

- Reads Aranet4 CO2, temperature, humidity, pressure, and battery data over Bluetooth Low Energy.
- Exposes native HomeKit `HumiditySensor`, `TemperatureSensor`, and `CarbonDioxideSensor` services.
- Supports multiple Aranet4 devices in one Homebridge instance.
- Uses each Aranet4 serial number as the stable accessory identity.
- Supports config-driven device enrollment with friendly names.
- Ignores unconfigured Aranet4 sensors when `autoDiscover` is disabled.
- Removes unconfigured cached accessories when running in explicit enrollment mode.
- Optionally exposes derived air quality and a compatibility CO2 ppm tile for Homebridge UI.

## Configuration

```json
{
  "platform": "Aranet4",
  "name": "Aranet4",
  "autoDiscover": false,
  "devices": [
    {
      "serialNumber": "123456789012",
      "name": "Bedroom Aranet4",
      "enabled": true
    },
    {
      "serialNumber": "987654321098",
      "name": "Living Room Aranet4",
      "enabled": true
    }
  ],
  "co2AlertThreshold": 1000,
  "batteryAlertThreshold": 10,
  "sensorDataRefreshInterval": 300,
  "bluetoothReadyTimeout": 30,
  "bluetoothDeviceSearchTimeout": 30
}
```

## Install From GitHub

```sh
npm install -g git+https://github.com/leoshimo/homebridge-aranet4.git
```

The repository includes a `prepare` script so installs from GitHub build the TypeScript source before Homebridge loads the plugin.

### Device Enrollment

By default, `autoDiscover` is `false`. In that mode, the plugin scans only to find the configured serial numbers and will not add unknown Aranet4 sensors.

Set `autoDiscover` to `true` if you want Homebridge to add every Aranet4 it finds during startup discovery.

### CO2 in Apple Home

The plugin exposes HomeKit's native `CarbonDioxideSensor` service and updates `CarbonDioxideLevel` in ppm. Apple Home usually shows the CO2 tile as a binary alarm state, such as `Detected` or `Not Detected`, instead of displaying ppm directly on the tile. The ppm characteristic is still available to HomeKit controllers that display raw characteristics.

`showCo2PpmTile` can be enabled as a compatibility workaround for Homebridge UI, but it uses a `LightSensor` service and Homebridge UI labels that value as `lux`. It is disabled by default.

## macOS Bluetooth Access

On macOS, the process running Homebridge must have Bluetooth permission in System Settings. If Homebridge cannot access Bluetooth, logs may show errors like `Bluetooth was not ready` or `Did not find any Aranet4 devices`.

## Development

```sh
npm install
npm run build
npm link
```

The package is written in TypeScript and compiles to `dist/`.
