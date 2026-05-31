import noble from '@abandonware/noble';
import { Logger } from 'homebridge';
import { TextDecoder } from 'util';

const ARANET4_SERVICE = '0000fce0-0000-1000-8000-00805f9b34fb';
const ARANET4_CHARACTERISTICS = 'f0cd300195da4f4b9ac8aa55d312af0c';

const DEVICE_INFO_SERVICE = '180a';
const MANUFACTURER_NAME = { key: 'manufacturer', id: '2a29' } as const;
const MODEL_NUMBER = { key: 'modelNumber', id: '2a24' } as const;
const SERIAL_NUMBER = { key: 'serialNumber', id: '2a25' } as const;
const HARDWARE_REVISION = { key: 'hardwareRevision', id: '2a27' } as const;
const FIRMWARE_REVISION = { key: 'firmwareRevision', id: '2a26' } as const;
const SOFTWARE_REVISION = { key: 'softwareRevision', id: '2a28' } as const;

const DEVICE_INFO_CHARACTERISTICS = [
  MANUFACTURER_NAME,
  MODEL_NUMBER,
  SERIAL_NUMBER,
  HARDWARE_REVISION,
  FIRMWARE_REVISION,
  SOFTWARE_REVISION,
];

const DEFAULT_DEVICE_INFO: Aranet4DeviceInfo = {
  manufacturer: 'SAF Tehnika',
  modelNumber: 'Aranet4',
  serialNumber: 'UNKNOWN_SERIAL',
  hardwareRevision: 'UNKNOWN_HARDWARE_REV',
  firmwareRevision: 'UNKNOWN_FIRMWARE_REV',
  softwareRevision: 'UNKNOWN_SOFTWARE_REV',
};

type NobleWithState = typeof noble & {
  state?: string;
  _state?: string;
};

export type Aranet4DeviceInfo = {
  manufacturer: string;
  modelNumber: string;
  serialNumber: string;
  hardwareRevision: string;
  firmwareRevision: string;
  softwareRevision: string;
  name?: string;
};

export type AranetData = {
  co2: number;
  temperature: number;
  pressure: number;
  humidity: number;
  battery: number;
};

type Aranet4DiscoveryOptions = {
  targetSerialNumbers?: string[];
  stopWhenAllTargetsFound?: boolean;
};

export class Aranet4Device {
  private static readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly logger: Logger,
    private readonly peripheral: noble.Peripheral,
    public readonly info: Aranet4DeviceInfo,
  ) {}

  static async waitForBluetooth(logger: Logger, timeoutSeconds: number): Promise<void> {
    const nobleWithState = noble as NobleWithState;

    if ((nobleWithState.state || nobleWithState._state) === 'poweredOn') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        noble.removeListener('stateChange', onStateChange);
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const rejectOnce = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      };

      const onStateChange = (state: string) => {
        logger.debug(`Bluetooth state changed to ${state}`);
        if (state === 'poweredOn') {
          resolveOnce();
        }
      };

      const timer = setTimeout(() => {
        rejectOnce(new Error(`Bluetooth was not ready after ${timeoutSeconds}s`));
      }, timeoutSeconds * 1000);

      noble.on('stateChange', onStateChange);
    });
  }

  static async getAranet4Devices(
    logger: Logger,
    bluetoothReadyTimeout: number,
    bluetoothDeviceSearchTimeout: number,
    options: Aranet4DiscoveryOptions = {},
  ): Promise<Aranet4Device[]> {
    const devicesBySerial = new Map<string, Aranet4Device>();
    const seenPeripheralIds = new Set<string>();
    const pendingDeviceReads = new Set<Promise<void>>();
    let deviceReadQueue = Promise.resolve();
    const targetSerialNumbers = new Set(
      (options.targetSerialNumbers || []).map((serialNumber) => String(serialNumber).trim()).filter(Boolean),
    );

    await this.waitForBluetooth(logger, bluetoothReadyTimeout);
    logger.debug('Starting Aranet4 Bluetooth scan...');

    await noble.startScanningAsync([ARANET4_SERVICE], false);

    return await new Promise<Aranet4Device[]>((resolve, reject) => {
      let settled = false;

      const cleanup = async () => {
        clearTimeout(timer);
        noble.removeListener('discover', onDiscover);
        try {
          await noble.stopScanningAsync();
        } catch (err) {
          logger.debug(`Could not stop Bluetooth scan: ${err}`);
        }
      };

      const finish = async () => {
        if (settled) {
          return;
        }
        settled = true;
        await cleanup();

        await Promise.all([...pendingDeviceReads].map((deviceRead) => deviceRead.catch(() => undefined)));

        const devices = [...devicesBySerial.values()];
        if (!devices.length) {
          reject(new Error('Did not find any Aranet4 devices'));
          return;
        }

        resolve(devices);
      };

      const allTargetDevicesFound = () => {
        return targetSerialNumbers.size > 0 &&
          [...targetSerialNumbers].every((serialNumber) => devicesBySerial.has(serialNumber));
      };

      const onDiscover = (peripheral: noble.Peripheral) => {
        if (settled || seenPeripheralIds.has(peripheral.uuid)) {
          return;
        }
        seenPeripheralIds.add(peripheral.uuid);
        logger.debug(`Found Aranet4 peripheral ${peripheral.uuid}`);

        const deviceRead = deviceReadQueue.then(async () => {
          const device = new Aranet4Device(logger, peripheral, { ...DEFAULT_DEVICE_INFO });
          await device.connect();

          const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
            [DEVICE_INFO_SERVICE],
            DEVICE_INFO_CHARACTERISTICS.map((c) => c.id),
          );

          for (const characteristic of characteristics) {
            const data = await characteristic.readAsync();
            const deviceInfo = DEVICE_INFO_CHARACTERISTICS.find((c) => c.id === characteristic.uuid);
            if (deviceInfo) {
              device.info[deviceInfo.key] = this.decoder.decode(data);
            }
          }

          if (device.info.serialNumber === DEFAULT_DEVICE_INFO.serialNumber) {
            device.info.serialNumber = peripheral.uuid;
          }

          if (!targetSerialNumbers.size || targetSerialNumbers.has(device.info.serialNumber)) {
            devicesBySerial.set(device.info.serialNumber, device);
            logger.info(`Found Aranet4 ${device.info.serialNumber}`);
          } else {
            logger.info(`Ignoring unconfigured Aranet4 ${device.info.serialNumber}`);
          }

          await peripheral.disconnectAsync();
          if (options.stopWhenAllTargetsFound && allTargetDevicesFound()) {
            setImmediate(() => {
              void finish();
            });
          }
        });
        deviceReadQueue = deviceRead.catch(() => undefined);

        pendingDeviceReads.add(deviceRead);
        deviceRead.catch(async (err) => {
          logger.error(`Could not read Aranet4 device information: ${err}`);
          try {
            await peripheral.disconnectAsync();
          } catch {
            // Ignore disconnect cleanup errors.
          }
        }).finally(() => {
          pendingDeviceReads.delete(deviceRead);
        });
      };

      const timer = setTimeout(finish, bluetoothDeviceSearchTimeout * 1000);
      noble.on('discover', onDiscover);
    });
  }

  async connect(): Promise<void> {
    if (this.peripheral.state !== 'connected') {
      this.logger.debug(`Connecting to Aranet4 ${this.peripheral.uuid}: ${this.peripheral.state}`);
      await this.peripheral.connectAsync();
    }
  }

  async getSensorData(bluetoothReadyTimeout: number): Promise<AranetData> {
    await Aranet4Device.waitForBluetooth(this.logger, bluetoothReadyTimeout);
    await this.connect();

    this.logger.debug(`Connected to Aranet4 ${this.peripheral.uuid}`);

    try {
      const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [ARANET4_SERVICE],
        [ARANET4_CHARACTERISTICS],
      );

      if (!characteristics.length) {
        throw new Error('Could not find the Aranet4 sensor characteristic');
      }

      const data = await characteristics[0].readAsync();

      return {
        co2: data.readUInt16LE(0),
        temperature: data.readUInt16LE(2) / 20,
        pressure: data.readUInt16LE(4) / 10,
        humidity: data.readUInt8(6),
        battery: data.readUInt8(7),
      };
    } finally {
      if (this.peripheral.state === 'connected') {
        await this.peripheral.disconnectAsync();
      }
    }
  }
}
