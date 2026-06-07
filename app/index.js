import mqtt from 'mqtt';
import os from 'os';
import fs from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEBUG = process.env.DEBUG === 'true';

const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const MQTT_URL = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
const HA_DISCOVERY_BASE = process.env.HA_DISCOVERY_BASE || 'homeassistant/sensor';

function resolveHostName() {
  const envHostName = (process.env.HOSTNAME || '').trim();
  if (envHostName !== '') {
    return envHostName;
  }

  try {
    const hostFsHostName = fs.readFileSync('/host/etc/hostname', 'utf8').trim();
    if (hostFsHostName !== '') {
      return hostFsHostName;
    }
  } catch {
    // Fall back to container hostname when host file is unavailable.
  }

  return os.hostname();
}

const HOSTNAME = resolveHostName();
const POLL_FREQUENCY_SECONDS = parseInt(process.env.POLL_FREQUENCY || '60', 10);
const DEFAULT_CORE_EXPIRE_AFTER_SECONDS = POLL_FREQUENCY_SECONDS * 3;
const DEFAULT_DISK_AGE_EXPIRE_AFTER_SECONDS = POLL_FREQUENCY_SECONDS * 10;
const SENSOR_EXPIRE_SECONDS = parseInt(process.env.SENSOR_EXPIRE || String(DEFAULT_CORE_EXPIRE_AFTER_SECONDS), 10);
const SENSOR_DISKAGE_EXPIRE_SECONDS = parseInt(process.env.SENSOR_DISKAGE_EXPIRE || String(DEFAULT_DISK_AGE_EXPIRE_AFTER_SECONDS), 10);
const HA_OBJECT_PREFIX = process.env.HA_OBJECT_PREFIX || `${HOSTNAME}_appprom`;
const MQTT_STATE_TOPIC = process.env.MQTT_STATE_TOPIC || `${HA_DISCOVERY_BASE}/${HA_OBJECT_PREFIX}/state`;
const COLLECTOR_PATH = process.env.COLLECTOR_PATH || '/collector.sh';

function debug(message) {
  if (!DEBUG) {
    return;
  }
  const time = new Date().toISOString();
  console.log(`[DEBUG ${time}] ${message}`);
}

async function collectMetrics() {
  const env = { ...process.env };
  const { stdout, stderr } = await execFileAsync('sh', [COLLECTOR_PATH], { env, maxBuffer: 1024 * 1024 * 4 });

  if (stderr && stderr.trim().length > 0) {
    debug(`collector stderr: ${stderr.trim()}`);
  }

  const raw = stdout.trim();
  if (!raw) {
    throw new Error('collector returned empty output');
  }

  return JSON.parse(raw);
}

function sensorDef(key, name, unit, valueTemplate, deviceClass = null, icon = null, expireAfter = null) {
  return { key, name, unit, valueTemplate, deviceClass, icon, expireAfter };
}

function publishDiscovery(client, device, payload) {
  const metrics = payload?.metrics || {};

  const sensors = [
    sensorDef('uptime', 'Uptime', 's', '{{ value_json.metrics.systemUptimeSeconds }}', 'duration', 'mdi:timer', SENSOR_EXPIRE_SECONDS),
    sensorDef('load1', 'Load 1m', '', "{{ value_json.metrics.cpuLoad['1m'] }}", null, 'mdi:gauge', SENSOR_EXPIRE_SECONDS),
    sensorDef('load5', 'Load 5m', '', "{{ value_json.metrics.cpuLoad['5m'] }}", null, 'mdi:gauge', SENSOR_EXPIRE_SECONDS),
    sensorDef('load15', 'Load 15m', '', "{{ value_json.metrics.cpuLoad['15m'] }}", null, 'mdi:gauge', SENSOR_EXPIRE_SECONDS),
    sensorDef('temperature', 'Temperature', '°C', '{{ value_json.metrics.systemTemperatureCelsius }}', 'temperature', 'mdi:thermometer'),
    sensorDef('systemdisk_total', 'System Disk Total', 'B', '{{ value_json.metrics.DiskSizeBytesRoot }}', 'data_size', 'mdi:harddisk'),
    sensorDef('systemdisk_used', 'System Disk Used', 'B', '{{ value_json.metrics.DiskUsageBytesRoot }}', 'data_size', 'mdi:harddisk'),
    sensorDef('systemdisk_usePercent', 'System Disk Use %', '%', '{{ value_json.metrics.DiskUsagePercentRoot }}', null, 'mdi:harddisk'),
    sensorDef('memory_total', 'Memory Total', 'B', '{{ value_json.metrics.memoryTotalBytes }}', 'data_size', 'mdi:memory'),
    sensorDef('memory_usedPercent', 'Memory Used %', '%', '{{ value_json.metrics.memoryUsagePercent }}', null, 'mdi:memory'),
    sensorDef('battery', 'Battery Level', '%', '{{ value_json.metrics.battery.capacityPercent }}', 'battery', 'mdi:battery', SENSOR_EXPIRE_SECONDS)
  ];

  // Add per-mount sensors dynamically from prom key suffixes.
  const mountSuffixes = new Set();
  Object.keys(metrics).forEach((k) => {
    const match = k.match(/^DiskSizeBytes(.+)$/);
    if (!match) {
      return;
    }
    const suffix = match[1];
    if (suffix !== 'Root') {
      mountSuffixes.add(suffix);
    }
  });

  mountSuffixes.forEach((suffix) => {
    const suffixLabel = suffix === 'Mount' ? 'root' : suffix;
    const mountSensors = [
      sensorDef(`disk_${suffix.toLowerCase()}_total`, `Disk ${suffixLabel} Total`, 'B', `{{ value_json.metrics.DiskSizeBytes${suffix} }}`, 'data_size', 'mdi:harddisk'),
      sensorDef(`disk_${suffix.toLowerCase()}_used`, `Disk ${suffixLabel} Used`, 'B', `{{ value_json.metrics.DiskUsageBytes${suffix} }}`, 'data_size', 'mdi:harddisk'),
      sensorDef(`disk_${suffix.toLowerCase()}_usePercent`, `Disk ${suffixLabel} Use %`, '%', `{{ value_json.metrics.DiskUsagePercent${suffix} }}`, null, 'mdi:harddisk')
    ];

    if (Object.prototype.hasOwnProperty.call(metrics, `FileCount${suffix}`)) {
      mountSensors.push(
        sensorDef(`disk_${suffix.toLowerCase()}_Files`, `Disk ${suffixLabel} Files`, '', `{{ value_json.metrics.FileCount${suffix} }}`, null, 'mdi:file-document-multiple')
      );
    }

    sensors.push(
      ...mountSensors
    );
  });

  // Add per-mount file age sensors when collector emits mountFileAgeSeconds<Suffix>.
  const fileAgeSuffixes = new Set();
  Object.keys(metrics).forEach((k) => {
    const match = k.match(/^mountFileAgeSeconds(.+)$/);
    if (!match) {
      return;
    }
    fileAgeSuffixes.add(match[1]);
  });

  fileAgeSuffixes.forEach((suffix) => {
    const suffixLabel = suffix === 'Mount' ? 'root' : suffix;
    sensors.push(
      sensorDef(`disk_${suffix.toLowerCase()}_AgeFile`, `Disk ${suffixLabel} AgeFile`, 's', `{{ value_json.metrics.mountFileAgeSeconds${suffix} }}`, 'duration', 'mdi:clock-outline', SENSOR_DISKAGE_EXPIRE_SECONDS)
    );
  });

  sensors.forEach((sensor) => {
    const config = {
      platform: 'mqtt',
      device,
      state_class: 'measurement',
      name: `${HOSTNAME} ${sensor.name}`,
      state_topic: MQTT_STATE_TOPIC,
      unit_of_measurement: sensor.unit,
      unique_id: `${HA_OBJECT_PREFIX}_${sensor.key}`,
      value_template: sensor.valueTemplate,
      ...(sensor.expireAfter !== null ? { expire_after: sensor.expireAfter } : {}),
      ...(sensor.deviceClass ? { device_class: sensor.deviceClass } : {}),
      ...(sensor.icon ? { icon: sensor.icon } : {})
    };

    const configTopic = `${HA_DISCOVERY_BASE}/${HA_OBJECT_PREFIX}_${sensor.key}/config`;
    client.publish(configTopic, JSON.stringify(config), { retain: true });
    debug(`published discovery topic ${configTopic}`);
  });
}

async function run() {
  const client = mqtt.connect(MQTT_URL);

  client.on('error', (err) => {
    debug(`MQTT error: ${String(err)}`);
  });

  client.on('connect', async () => {
    debug(`connected to MQTT at ${MQTT_URL}`);

    const device = {
      identifiers: HOSTNAME,
      name: HOSTNAME,
      manufacturer: process.env.MANUFACTURER || 'Pihl',
      model: process.env.MODEL || 'Hass Sysinfo',
      sw_version: process.env.SW_VERSION || '2.0.0',
      serial_number: process.env.SERIAL || '',
      suggested_area: process.env.SUGGESTED_AREA || ''
    };

    Object.keys(device).forEach((k) => {
      if (device[k] === undefined || device[k] === '') {
        delete device[k];
      }
    });

    let discoveryPublished = false;

    const publishState = async () => {
      try {
        const payload = await collectMetrics();
        if (!discoveryPublished) {
          publishDiscovery(client, device, payload);
          discoveryPublished = true;
        }
        client.publish(MQTT_STATE_TOPIC, JSON.stringify(payload));
        debug(`published state to ${MQTT_STATE_TOPIC}: ${JSON.stringify(payload)}`);
      } catch (error) {
        debug(`collect/publish failed: ${String(error)}`);
      }
    };

    // Publish immediately on connect, then continue at poll interval.
    publishState();
    setInterval(publishState, POLL_FREQUENCY_SECONDS * 1000);
  });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
