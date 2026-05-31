import { PlatformAccessory, Service, WithUUID } from 'homebridge';

import { Aranet4Device, AranetData } from './aranet';
import { Aranet4Platform } from './platform';

type ServiceWithConfiguredName = Service & {
  testCharacteristic?: (characteristic: unknown) => boolean;
};
type ServiceType = WithUUID<typeof Service>;

export class Aranet4Accessory {
  private readonly humidityService: Service;
  private readonly temperatureService: Service;
  private readonly co2Service: Service;
  private readonly co2PpmService?: Service;
  private readonly airQualityService?: Service;
  private readonly services: Service[];
  private readonly name: string;
  private readonly serviceNames: {
    humidity: string;
    temperature: string;
    co2: string;
    co2Ppm: string;
    airQuality: string;
  };

  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: Aranet4Platform,
    private readonly accessory: PlatformAccessory,
    private readonly device: Aranet4Device,
  ) {
    this.name = device.info.name || this.accessory.context?.device?.name || 'Aranet4';
    this.serviceNames = {
      humidity: `${this.name} Humidity`,
      temperature: `${this.name} Temperature`,
      co2: `${this.name} CO2 Alert`,
      co2Ppm: `${this.name} CO2 ppm`,
      airQuality: `${this.name} Air Quality`,
    };

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, device.info.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, device.info.modelNumber)
      .setCharacteristic(this.platform.Characteristic.Name, this.name)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.info.serialNumber)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, device.info.firmwareRevision);

    this.humidityService = this.getOrAddPrimaryService(
      this.platform.Service.HumiditySensor,
      this.serviceNames.humidity,
    );
    this.temperatureService = this.getOrAddPrimaryService(
      this.platform.Service.TemperatureSensor,
      this.serviceNames.temperature,
    );
    this.co2Service = this.getOrAddPrimaryService(
      this.platform.Service.CarbonDioxideSensor,
      this.serviceNames.co2,
    );

    this.co2PpmService = this.platform.config.showCo2PpmTile
      ? this.getOrAddService(this.platform.Service.LightSensor, this.serviceNames.co2Ppm, 'co2-ppm')
      : undefined;
    if (!this.co2PpmService) {
      this.removeOptionalService(this.platform.Service.LightSensor, this.serviceNames.co2Ppm, 'co2-ppm');
    }

    this.airQualityService = this.platform.config.showAirQualitySensor
      ? this.getOrAddService(this.platform.Service.AirQualitySensor, this.serviceNames.airQuality, 'air-quality')
      : undefined;
    if (!this.airQualityService) {
      this.removeOptionalService(this.platform.Service.AirQualitySensor, this.serviceNames.airQuality, 'air-quality');
    }

    this.setServiceName(this.humidityService, this.serviceNames.humidity);
    this.humidityService.setCharacteristic(this.platform.Characteristic.StatusActive, true);
    this.setServiceName(this.temperatureService, this.serviceNames.temperature);
    this.temperatureService.setCharacteristic(this.platform.Characteristic.StatusActive, true);
    this.setServiceName(this.co2Service, this.serviceNames.co2);
    this.co2Service.setCharacteristic(this.platform.Characteristic.StatusActive, true);

    if (this.co2PpmService) {
      this.setServiceName(this.co2PpmService, this.serviceNames.co2Ppm);
      this.co2PpmService.setCharacteristic(this.platform.Characteristic.StatusActive, true);
    }

    if (this.airQualityService) {
      this.setServiceName(this.airQualityService, this.serviceNames.airQuality);
      this.airQualityService.setCharacteristic(this.platform.Characteristic.StatusActive, true);
    }

    this.services = [
      this.humidityService,
      this.temperatureService,
      this.co2Service,
      this.co2PpmService,
      this.airQualityService,
    ].filter((service): service is Service => Boolean(service));

    this.setInitialValues();
    this.startRefreshLoop();
  }

  private getOrAddPrimaryService(ServiceType: ServiceType, name: string): Service {
    const service = this.accessory.getService(ServiceType) ||
      this.accessory.getService(name) ||
      this.accessory.addService(ServiceType, name, name);

    this.removeDuplicatePrimaryServices(ServiceType, service);
    this.removeUnsupportedConfiguredName(service);

    return service;
  }

  private setServiceName(service: Service, name: string) {
    service.displayName = name;
    service.setCharacteristic(this.platform.Characteristic.Name, name);
  }

  private getOrAddService(ServiceType: ServiceType, name: string, subtype: string): Service {
    if (typeof this.accessory.getServiceById === 'function') {
      const existingById = this.accessory.getServiceById(ServiceType, subtype);
      if (existingById) {
        return existingById;
      }
    }

    return this.accessory.getService(name) || this.accessory.addService(ServiceType, name, subtype);
  }

  private removeOptionalService(ServiceType: ServiceType, name: string, subtype: string) {
    const services = new Set<Service>();

    if (typeof this.accessory.getServiceById === 'function') {
      const byId = this.accessory.getServiceById(ServiceType, subtype);
      if (byId) {
        services.add(byId);
      }
    }

    const byName = this.accessory.getService(name);
    if (byName && byName.UUID === ServiceType.UUID) {
      services.add(byName);
    }

    for (const service of services) {
      this.platform.log.warn(`Removing disabled cached Aranet4 service: ${name}`);
      this.accessory.removeService(service);
    }
  }

  private removeDuplicatePrimaryServices(ServiceType: ServiceType, serviceToKeep: Service) {
    const duplicateServices = this.accessory.services.filter((service) => {
      return service.UUID === ServiceType.UUID && service !== serviceToKeep;
    });

    for (const duplicateService of duplicateServices) {
      this.platform.log.warn(
        `Removing duplicate cached Aranet4 service: ${duplicateService.displayName || ServiceType.name}`,
      );
      this.accessory.removeService(duplicateService);
    }
  }

  private removeUnsupportedConfiguredName(service: Service) {
    const serviceWithConfiguredName = service as ServiceWithConfiguredName;
    const ConfiguredName = this.platform.Characteristic.ConfiguredName;

    if (
      typeof serviceWithConfiguredName.testCharacteristic === 'function' &&
      serviceWithConfiguredName.testCharacteristic(ConfiguredName)
    ) {
      service.removeCharacteristic(service.getCharacteristic(ConfiguredName));
    }
  }

  private setInitialValues() {
    this.humidityService
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .updateValue(0);
    this.temperatureService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .updateValue(0);
    this.co2Service
      .getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)
      .updateValue(this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL);
    this.co2Service
      .getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
      .updateValue(0);
    this.co2Service
      .getCharacteristic(this.platform.Characteristic.CarbonDioxidePeakLevel)
      .updateValue(0);

    if (this.co2PpmService) {
      this.co2PpmService
        .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
        .updateValue(0.0001);
    }

    if (this.airQualityService) {
      this.airQualityService
        .getCharacteristic(this.platform.Characteristic.AirQuality)
        .updateValue(this.platform.Characteristic.AirQuality.UNKNOWN);
    }

    for (const service of this.services) {
      service
        .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
        .updateValue(this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    }
  }

  private startRefreshLoop() {
    void this.updateSensorData();

    const intervalSeconds = Math.max(30, Number(this.platform.config.sensorDataRefreshInterval) || 300);
    this.refreshTimer = setInterval(() => {
      void this.updateSensorData();
    }, intervalSeconds * 1000);
  }

  async updateSensorData() {
    let data: AranetData;
    try {
      data = await this.device.getSensorData(this.platform.config.bluetoothReadyTimeout);
    } catch (err) {
      this.platform.log.error(`Could not get Aranet4 sensor data: ${err}`);
      return;
    }

    const batteryLevel = data.battery <= this.platform.config.batteryAlertThreshold
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    for (const service of this.services) {
      service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, batteryLevel);
    }

    this.humidityService.updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      data.humidity,
    );
    this.temperatureService.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      data.temperature,
    );

    const detected = data.co2 >= this.platform.config.co2AlertThreshold
      ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
      : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;

    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideDetected, detected);
    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, data.co2);
    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxidePeakLevel, data.co2);

    if (this.co2PpmService) {
      this.co2PpmService.updateCharacteristic(
        this.platform.Characteristic.CurrentAmbientLightLevel,
        Math.max(0.0001, data.co2),
      );
    }

    if (this.airQualityService) {
      this.airQualityService.updateCharacteristic(
        this.platform.Characteristic.AirQuality,
        this.getAirQuality(data.co2),
      );
    }

    this.platform.log.info(
      `Updated ${this.name}: CO2 ${data.co2} ppm, temperature ${data.temperature} C, ` +
      `humidity ${data.humidity}%, battery ${data.battery}%`,
    );
    this.platform.log.debug('Updated Aranet4 raw data:', data);
  }

  private getAirQuality(co2: number): number {
    const AirQuality = this.platform.Characteristic.AirQuality;

    if (co2 <= 800) {
      return AirQuality.EXCELLENT;
    }
    if (co2 <= 1000) {
      return AirQuality.GOOD;
    }
    if (co2 <= 1400) {
      return AirQuality.FAIR;
    }
    if (co2 <= 2000) {
      return AirQuality.INFERIOR;
    }
    return AirQuality.POOR;
  }
}
