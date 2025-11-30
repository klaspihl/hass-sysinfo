


const DEBUG = process.env.DEBUG === 'true';
import mqtt from 'mqtt';
import { collect, getSystemType, getSerialAndModel, getHostName } from './collect.js';

const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const MQTT_URL = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;

// Centralized host info
const HOSTNAME = process.env.HOSTNAME || getHostName();
const SYSTEM_TYPE = process.env.SYSTEM_TYPE || getSystemType();
const SW_VERSION = '1.0';
const MODEL = process.env.MODEL || getSerialAndModel(SYSTEM_TYPE).model;
const SERIAL = process.env.SERIAL || getSerialAndModel(SYSTEM_TYPE).serial ;

function debug(msg) {
  const time = new Date().toISOString();
  if (DEBUG) {
    console.log(`[DEBUG ${time}] ${msg}`);
  }
  if (client && client.connected) {
    client.publish('/debug/', `[${time}] ${msg}`);
  }
}

const client = mqtt.connect(MQTT_URL);

client.on('connect', async () => {
  debug('Connected to MQTT broker');
  // Send MQTT autodiscovery for each measurement
  const device = {
    identifiers:  HOSTNAME,
    name: HOSTNAME,
    manufacturer: process.env.MANUFACTURER || '20060620',
    model: MODEL,
    sw_version: SW_VERSION,
    hw_version: process.env.HW_VERSION || '',
    serial_number: SERIAL,
    suggested_area: process.env.SUGGESTED_AREA || '',
  };
  // Remove undefined and empty string fields
  Object.keys(device).forEach(k => {
    if (device[k] === undefined || device[k] === '') delete device[k];
  });
  // Dynamically create sensors for each data disk, only if any data disks are found
  const data = await collect();
  const datadisks = data.datadisks || {};
  const dataDiskNames = Object.keys(datadisks);
  if (dataDiskNames.length > 0) {
    dataDiskNames.forEach(disk => {
      const prefix = `datadisk_${disk}`;
      const diskName = disk;
      const diskSensors = [
        { key: `${prefix}_used`, name: `Disk ${diskName} Used`, unit: 'GB', value_template: `{{ value_json.datadisks.${disk}.used }}`, device_class: 'data_size', icon: 'mdi:harddisk', suggested_display_precision: 0 },
        { key: `${prefix}_usePercent`, name: `Disk ${diskName} Use %`, unit: '%', value_template: `{{ value_json.datadisks.${disk}.usePercent }}`, device_class: 'power_factor', icon: 'mdi:harddisk', suggested_display_precision: 0 },
        { key: `${prefix}_Files`, name: `Disk ${diskName} Files`,unit: "#", value_template: `{{ value_json.datadisks.${disk}.Files }}`, device_class: 'temperature', icon: 'mdi:harddisk', suggested_display_precision: 0 },
        { key: `${prefix}_AgeFile`, name: `Disk ${diskName} AgeFile`, unit: 's', value_template: `{{ value_json.datadisks.${disk}.AgeFile }}`, device_class: 'duration', icon: 'mdi:harddisk', suggested_display_precision: 0 },
      ];
      diskSensors.forEach(sensor => {
        const config = {
          device,
          device_class: sensor.device_class,
          state_class: 'measurement',
          name: `${HOSTNAME} ${sensor.name}`,
          state_topic: `homeassistant/sensor/${HOSTNAME}/state`,
          unit_of_measurement: sensor.unit,
          unique_id: `${HOSTNAME}_${sensor.key}`,
          value_template: sensor.value_template,
          platform: 'mqtt',
          ...(sensor.icon ? { icon: sensor.icon } : {})
        };
        client.publish(`homeassistant/sensor/${HOSTNAME}_${sensor.key}/config`, JSON.stringify(config), {retain: true});
        debug(`Sent MQTT autodiscovery for ${sensor.name}`);
      });
    });
  }

  // Other sensors (uptime, load, temp, systemdisk, memory, battery)
  const sensors = [
    { key: 'uptime', name: 'Uptime', unit: 's', value_template: '{{ value_json.uptime }}', device_class: 'duration', suggested_display_precision: 0, expire_after: 3600, icon: 'mdi:timer' },
    { key: 'load1', name: 'Load 1m', unit: '', value_template: '{{ value_json.load1 }}', device_class: 'power_factor', icon: 'mdi:gauge' },
    { key: 'load5', name: 'Load 5m', unit: '', value_template: '{{ value_json.load5 }}', device_class: 'power_factor', icon: 'mdi:gauge' },
    { key: 'load15', name: 'Load 15m', unit: '', value_template: '{{ value_json.load15 }}', device_class: 'power_factor', icon: 'mdi:gauge' },
    { key: 'temperature', name: 'Temperature', unit: '°C', value_template: '{{ value_json.temperature }}', device_class: 'temperature', icon: 'mdi:thermometer' },
    { key: 'systemdisk_total', name: 'System Disk Total', unit: 'GB', value_template: '{{ value_json.systemdisk.total }}', device_class: 'data_size', icon: 'mdi:harddisk', suggested_display_precision: 0 },
    { key: 'systemdisk_used', name: 'System Disk Used', unit: 'GB', value_template: '{{ value_json.systemdisk.used }}', device_class: 'data_size', icon: 'mdi:harddisk', suggested_display_precision: 0 },
    { key: 'systemdisk_usePercent', name: 'System Disk Use %', unit: '%', value_template: '{{ value_json.systemdisk.usePercent }}', device_class: 'power_factor', icon: 'mdi:harddisk', suggested_display_precision: 0 },
    { key: 'memory_total', name: 'Memory Total', unit: 'GB', value_template: '{{ value_json.memory.total }}', device_class: 'data_size',suggested_display_precision: 0, icon: 'mdi:memory' },
    { key: 'memory_used', name: 'Memory Used', unit: 'GB', value_template: '{{ value_json.memory.used }}', device_class: 'data_size', suggested_display_precision: 0, icon: 'mdi:memory' },
    { key: 'memory_usedPercent', name: 'Memory Used %', unit: '%', value_template: '{{ value_json.memory.usedPercent }}', device_class: 'power_factor', suggested_display_precision: 0, icon: 'mdi:memory' }
  ];

  // Add battery sensor if present in data
  if ('battery' in data) {
    sensors.push({
      key: 'battery',
      name: 'Battery Level',
      unit: '%',
      value_template: '{{ value_json.battery }}',
      device_class: 'battery',
      icon: 'mdi:battery',
      suggested_display_precision: 0
    });
  }
  sensors.forEach(sensor => {
    const config = {
      device,
      device_class: sensor.device_class,
      state_class: 'measurement',
      name: `${HOSTNAME} ${sensor.name}`,
      state_topic: `homeassistant/sensor/${HOSTNAME}/state`,
      unit_of_measurement: sensor.unit,
      unique_id: `${HOSTNAME}_${sensor.key}`,
      value_template: sensor.value_template,
      platform: 'mqtt',
      ...(sensor.icon ? { icon: sensor.icon } : {})
    };
    client.publish(`homeassistant/sensor/${HOSTNAME}_${sensor.key}/config`, JSON.stringify(config), {retain: true});
  debug(`Sent MQTT autodiscovery for ${sensor.name}`);
  });

  // Start periodic data collection

const pollFrequency = parseInt(process.env.pollFrequency, 10) || 60;

setInterval(async () => {
    try {
      const data = await collect();
      client.publish(`homeassistant/sensor/${HOSTNAME}/state`, JSON.stringify(data));
  debug('Published system data');
    } catch (e) {
      debug('Error collecting or publishing data: ' + e);
    }
  }, pollFrequency * 1000);

});

client.on('error', err => {
  debug('MQTT error: ' + err);
});
