"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Aranet4Device = void 0;
const noble_1 = __importDefault(require("@abandonware/noble"));
const util_1 = require("util");
const ARANET4_SERVICE = '0000fce0-0000-1000-8000-00805f9b34fb';
const ARANET4_CHARACTERISTICS = 'f0cd300195da4f4b9ac8aa55d312af0c';
const DEVICE_INFO_SERVICE = '180a';
const MANUFACTURER_NAME = { key: 'manufacturer', id: '2a29' };
const MODEL_NUMBER = { key: 'modelNumber', id: '2a24' };
const SERIAL_NUMBER = { key: 'serialNumber', id: '2a25' };
const HARDWARE_REVISION = { key: 'hardwareRevision', id: '2a27' };
const FIRMWARE_REVISION = { key: 'firmwareRevision', id: '2a26' };
const SOFTWARE_REVISION = { key: 'softwareRevision', id: '2a28' };
const DEVICE_INFO_CHARACTERISTICS = [
    MANUFACTURER_NAME,
    MODEL_NUMBER,
    SERIAL_NUMBER,
    HARDWARE_REVISION,
    FIRMWARE_REVISION,
    SOFTWARE_REVISION,
];
const DEFAULT_DEVICE_INFO = {
    manufacturer: 'SAF Tehnika',
    modelNumber: 'Aranet4',
    serialNumber: 'UNKNOWN_SERIAL',
    hardwareRevision: 'UNKNOWN_HARDWARE_REV',
    firmwareRevision: 'UNKNOWN_FIRMWARE_REV',
    softwareRevision: 'UNKNOWN_SOFTWARE_REV',
};
class Aranet4Device {
    constructor(logger, peripheral, info) {
        this.logger = logger;
        this.peripheral = peripheral;
        this.info = info;
    }
    static async waitForBluetooth(logger, timeoutSeconds) {
        const nobleWithState = noble_1.default;
        if ((nobleWithState.state || nobleWithState._state) === 'poweredOn') {
            return;
        }
        await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                noble_1.default.removeListener('stateChange', onStateChange);
            };
            const resolveOnce = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve();
            };
            const rejectOnce = (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(err);
            };
            const onStateChange = (state) => {
                logger.debug(`Bluetooth state changed to ${state}`);
                if (state === 'poweredOn') {
                    resolveOnce();
                }
            };
            const timer = setTimeout(() => {
                rejectOnce(new Error(`Bluetooth was not ready after ${timeoutSeconds}s`));
            }, timeoutSeconds * 1000);
            noble_1.default.on('stateChange', onStateChange);
        });
    }
    static async getAranet4Devices(logger, bluetoothReadyTimeout, bluetoothDeviceSearchTimeout, options = {}) {
        const devicesBySerial = new Map();
        const seenPeripheralIds = new Set();
        const pendingDeviceReads = new Set();
        let deviceReadQueue = Promise.resolve();
        const targetSerialNumbers = new Set((options.targetSerialNumbers || []).map((serialNumber) => String(serialNumber).trim()).filter(Boolean));
        await this.waitForBluetooth(logger, bluetoothReadyTimeout);
        logger.debug('Starting Aranet4 Bluetooth scan...');
        await noble_1.default.startScanningAsync([ARANET4_SERVICE], false);
        return await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = async () => {
                clearTimeout(timer);
                noble_1.default.removeListener('discover', onDiscover);
                try {
                    await noble_1.default.stopScanningAsync();
                }
                catch (err) {
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
            const onDiscover = (peripheral) => {
                if (settled || seenPeripheralIds.has(peripheral.uuid)) {
                    return;
                }
                seenPeripheralIds.add(peripheral.uuid);
                logger.debug(`Found Aranet4 peripheral ${peripheral.uuid}`);
                const deviceRead = deviceReadQueue.then(async () => {
                    const device = new Aranet4Device(logger, peripheral, { ...DEFAULT_DEVICE_INFO });
                    await device.connect();
                    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync([DEVICE_INFO_SERVICE], DEVICE_INFO_CHARACTERISTICS.map((c) => c.id));
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
                    }
                    else {
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
                    }
                    catch (_a) {
                        // Ignore disconnect cleanup errors.
                    }
                }).finally(() => {
                    pendingDeviceReads.delete(deviceRead);
                });
            };
            const timer = setTimeout(finish, bluetoothDeviceSearchTimeout * 1000);
            noble_1.default.on('discover', onDiscover);
        });
    }
    async connect() {
        if (this.peripheral.state !== 'connected') {
            this.logger.debug(`Connecting to Aranet4 ${this.peripheral.uuid}: ${this.peripheral.state}`);
            await this.peripheral.connectAsync();
        }
    }
    async getSensorData(bluetoothReadyTimeout) {
        await Aranet4Device.waitForBluetooth(this.logger, bluetoothReadyTimeout);
        await this.connect();
        this.logger.debug(`Connected to Aranet4 ${this.peripheral.uuid}`);
        try {
            const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync([ARANET4_SERVICE], [ARANET4_CHARACTERISTICS]);
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
        }
        finally {
            if (this.peripheral.state === 'connected') {
                await this.peripheral.disconnectAsync();
            }
        }
    }
}
exports.Aranet4Device = Aranet4Device;
Aranet4Device.decoder = new util_1.TextDecoder('utf-8');
