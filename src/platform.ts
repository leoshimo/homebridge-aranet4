import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, WithUUID } from 'homebridge';

import { Aranet4Device } from './aranet';
import { Aranet4Accessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

const DEFAULT_CONFIG = {
  autoDiscover: false,
  devices: [] as Aranet4ConfiguredDevice[],
  co2AlertThreshold: 1000,
  batteryAlertThreshold: 10,
  sensorDataRefreshInterval: 300,
  bluetoothReadyTimeout: 30,
  bluetoothDeviceSearchTimeout: 30,
  showCo2PpmTile: false,
  showAirQualitySensor: false,
};

export type Aranet4ConfiguredDevice = {
  serialNumber: string;
  name: string;
  enabled: boolean;
};

export type Aranet4PlatformConfig = PlatformConfig & typeof DEFAULT_CONFIG;
type ServiceType = WithUUID<typeof Service>;

export class Aranet4Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly config: Aranet4PlatformConfig;

  private readonly configuredDevicesBySerial: Map<string, Aranet4ConfiguredDevice>;
  private retryTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      devices: this.normalizeDeviceConfigs(config.devices),
    };
    this.configuredDevicesBySerial = new Map(
      this.config.devices.map((device) => [device.serialNumber, device]),
    );

    this.log.debug(`Initialized ${PLUGIN_NAME}: ${JSON.stringify(this.config)}`);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Homebridge finished launching; discovering Aranet4 devices');
      this.removeUnconfiguredCachedAccessories();
      this.syncConfiguredCachedAccessories();
      void this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }

    const configuredDevices = this.getEnabledConfiguredDevices();
    const configuredSerialNumbers = configuredDevices.map((device) => device.serialNumber);

    if (!this.config.autoDiscover && configuredSerialNumbers.length === 0) {
      this.log.warn('Aranet4 auto-discovery is disabled and no devices are configured; not scanning');
      return;
    }

    let devices: Aranet4Device[];
    try {
      devices = await Aranet4Device.getAranet4Devices(
        this.log,
        this.config.bluetoothReadyTimeout,
        this.config.bluetoothDeviceSearchTimeout,
        {
          targetSerialNumbers: this.config.autoDiscover ? [] : configuredSerialNumbers,
          stopWhenAllTargetsFound: !this.config.autoDiscover && configuredSerialNumbers.length > 0,
        },
      );
    } catch (err) {
      this.log.error(`Could not discover Aranet4 devices: ${err}`);
      if (this.config.autoDiscover) {
        this.scheduleDiscoveryRetry();
      }
      return;
    }

    const managedDevices = devices.filter((device) => {
      return this.config.autoDiscover || this.configuredDevicesBySerial.has(device.info.serialNumber);
    });
    const foundSerialNumbers = new Set(managedDevices.map((device) => device.info.serialNumber));

    for (const configuredDevice of configuredDevices) {
      if (!foundSerialNumbers.has(configuredDevice.serialNumber)) {
        this.log.warn(
          `Configured Aranet4 ${configuredDevice.serialNumber} (${configuredDevice.name}) was not found during scan`,
        );
      }
    }

    for (const device of managedDevices) {
      const configuredDevice = this.configuredDevicesBySerial.get(device.info.serialNumber);
      const accessoryName = configuredDevice?.name || device.info.modelNumber;
      device.info.name = accessoryName;

      const uuid = this.api.hap.uuid.generate(device.info.serialNumber);
      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', accessoryName);
        existingAccessory.displayName = accessoryName;
        existingAccessory.context.device = {
          serialNumber: device.info.serialNumber,
          modelNumber: device.info.modelNumber,
          name: accessoryName,
        };
        new Aranet4Accessory(this, existingAccessory, device);
        this.api.updatePlatformAccessories([existingAccessory]);
        continue;
      }

      this.log.info('Adding new Aranet4 accessory:', accessoryName);
      const accessory = new this.api.platformAccessory(accessoryName, uuid);
      accessory.context.device = {
        serialNumber: device.info.serialNumber,
        modelNumber: device.info.modelNumber,
        name: accessoryName,
      };
      new Aranet4Accessory(this, accessory, device);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  private normalizeDeviceConfigs(devices: unknown): Aranet4ConfiguredDevice[] {
    if (!Array.isArray(devices)) {
      return [];
    }

    const devicesBySerial = new Map<string, Aranet4ConfiguredDevice>();

    for (const rawDevice of devices) {
      const device = rawDevice as Partial<Aranet4ConfiguredDevice>;
      const serialNumber = String(device.serialNumber || '').trim();
      if (!serialNumber) {
        continue;
      }

      devicesBySerial.set(serialNumber, {
        serialNumber,
        name: String(device.name || `Aranet4 ${serialNumber}`).trim(),
        enabled: device.enabled !== false,
      });
    }

    return [...devicesBySerial.values()];
  }

  private getEnabledConfiguredDevices(): Aranet4ConfiguredDevice[] {
    return this.config.devices.filter((device) => device.enabled);
  }

  private removeUnconfiguredCachedAccessories() {
    if (this.config.autoDiscover || !this.configuredDevicesBySerial.size) {
      return;
    }

    const enabledSerialNumbers = new Set(
      this.getEnabledConfiguredDevices().map((device) => device.serialNumber),
    );
    const staleAccessories = this.accessories.filter((accessory) => {
      const serialNumber = accessory.context?.device?.serialNumber;
      return serialNumber && !enabledSerialNumbers.has(serialNumber);
    });

    if (!staleAccessories.length) {
      return;
    }

    for (const accessory of staleAccessories) {
      this.log.warn('Removing unconfigured Aranet4 accessory from cache:', accessory.displayName);
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    this.accessories.splice(
      0,
      this.accessories.length,
      ...this.accessories.filter((accessory) => !staleAccessories.includes(accessory)),
    );
  }

  private syncConfiguredCachedAccessories() {
    const updatedAccessories: PlatformAccessory[] = [];

    for (const accessory of this.accessories) {
      const serialNumber = accessory.context?.device?.serialNumber;
      const configuredDevice = serialNumber && this.configuredDevicesBySerial.get(serialNumber);
      if (!configuredDevice || !configuredDevice.enabled) {
        continue;
      }

      accessory.displayName = configuredDevice.name;
      accessory.context.device = {
        ...accessory.context.device,
        serialNumber,
        name: configuredDevice.name,
      };

      this.renameCachedService(accessory, this.Service.HumiditySensor, `${configuredDevice.name} Humidity`);
      this.renameCachedService(accessory, this.Service.TemperatureSensor, `${configuredDevice.name} Temperature`);
      this.renameCachedService(accessory, this.Service.CarbonDioxideSensor, `${configuredDevice.name} CO2 Alert`);
      this.renameCachedService(accessory, this.Service.LightSensor, `${configuredDevice.name} CO2 ppm`);
      this.renameCachedService(accessory, this.Service.AirQualitySensor, `${configuredDevice.name} Air Quality`);

      updatedAccessories.push(accessory);
    }

    if (updatedAccessories.length) {
      this.api.updatePlatformAccessories(updatedAccessories);
    }
  }

  private renameCachedService(accessory: PlatformAccessory, ServiceType: ServiceType, name: string) {
    const service = accessory.services.find((candidate) => candidate.UUID === ServiceType.UUID);
    if (!service) {
      return;
    }

    service.displayName = name;
    service.setCharacteristic(this.Characteristic.Name, name);
  }

  private scheduleDiscoveryRetry() {
    const retrySeconds = Math.max(60, Number(this.config.sensorDataRefreshInterval) || 300);
    this.log.info(`Will retry Aranet4 discovery in ${retrySeconds}s`);
    this.retryTimer = setTimeout(() => {
      void this.discoverDevices();
    }, retrySeconds * 1000);
  }
}
