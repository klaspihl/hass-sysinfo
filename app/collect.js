import { exec } from 'child_process';
//import os from 'os';
import fs from 'fs';
import path from 'path';
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const DEBUG = process.env.DEBUG === 'true';

function debug(msg) {
  if (DEBUG) {
    const time = new Date().toISOString();
    console.log(`[DEBUG ${time}] ${msg}`);
  }
}

// Container host hostname or env variable HOSTNAME
function getHostName() {
    let hostHostname = null;
    try {
      hostHostname = fs.readFileSync('/host/etc/hostname', 'utf8').trim();
    } catch {}
    return hostHostname;
}

// From from container prod/cpuinto find what cpu architecture and from that return system type. Examples: 'raspberrypi', 'x86', 'virtual'
function getSystemType() {
  const SYSTEM_COMMANDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'system_commands.json'), 'utf8'));
  try {
    const cpuinfo = fs.readFileSync(SYSTEM_COMMANDS.common.cpuinfo, 'utf8');
    // Raspberry Pi (ARM)
    if (/Raspberry Pi/i.test(cpuinfo)) return 'raspberrypi';
    // ARM (generic)
    if (/ARMv|AArch|BCM|Cortex|Hardware\s*:\s*BCM/i.test(cpuinfo)) return 'raspberrypi';
    // x86/AMD64
    if (/GenuineIntel|AuthenticAMD|model name\s*:.*Intel|model name\s*:.*AMD/i.test(cpuinfo)) return 'x86';
    // Virtualized (QEMU, KVM, etc)
    if (/QEMU|KVM|VirtualBox|VMware|Microsoft Hv|Xen/i.test(cpuinfo)) return 'virtual';
  } catch {}

}

export { debug, getHostName, getSystemType,getSerialAndModel };

// Find all folders in /host/ whose names start with "data"
// @returns {string[]} Array of absolute paths to matching folders
function findDataFolders() {
  const baseDir = '/host/';
  let result = [];
  if (!fs.existsSync(baseDir)) return result;

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  debug('Entries in /host/: ' + entries.map(e => e.name));
  debug('Entries details: ' + JSON.stringify(entries));
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'sysfolder' && entry.name !== 'etc') {
      result.push(path.join(baseDir, entry.name));
    } else {
      debug(`Skipping entry ${entry.name}, isDirectory: ${entry.isDirectory()}`);
    }
  }
  return result;
}

function getSerialAndModel(systemType) {
  const SYSTEM_COMMANDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'system_commands.json'), 'utf8'));
  const device = SYSTEM_COMMANDS[systemType];
  let devicemodel = null;
  let deviceserial = null;
  if (device.deviceModel) {
    try {
      const modelRaw = fs.readFileSync(device.deviceModel, 'utf8');
      devicemodel = modelRaw.trim();
      debug('Device model: ' + devicemodel);
    } catch (e) {
      debug('Error reading device model: ' + e);
    }
  }
  if (device.deviceSerial) {
    try {
      const serialRaw = fs.readFileSync(device.deviceSerial, 'utf8');
      deviceserial = serialRaw.trim();
      debug('Device serial: ' + deviceserial);
    } catch (e) {
      debug('Error reading device serial: ' + e);
    }
  }
  return { model: devicemodel, serial: deviceserial };
}
async function collect() {
  const execP = (cmd, opts) => new Promise((resolve) => exec(cmd, opts || {}, (e, out) => resolve(e ? '' : out)));

  const systemType = getSystemType();

  const SYSTEM_COMMANDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'system_commands.json'), 'utf8'));
  const commands = SYSTEM_COMMANDS['common'];
  debug('Using system commands: ' + commands);
  const device = SYSTEM_COMMANDS[systemType];
 

  // Battery charge level (if present)
  let battery = null;
  if (device.battery) {
    try {
      const batteryRaw = await execP(device.battery);
      const batteryVal = parseInt(batteryRaw.trim(), 10);
      if (!isNaN(batteryVal)) battery = batteryVal;
      debug('Battery level: ' + battery);
    } catch (e) {
      debug('No battery found or error reading battery: ' + e);
    }
  }

  // Disk /
  const diskRaw = await execP(commands.systemDisk);
  debug('Disk / raw:\n' + diskRaw);
  let diskLines = diskRaw.trim().split('\n');
  let diskRoot = diskLines.find(l => l.includes('/dev/')) || '';
  let diskParts = diskRoot.split(/\s+/);
  const systemdisk = {
    total: Math.round((parseInt(diskParts[1], 10) * 1024 || 0) / (1024 * 1024 * 1024)),
    used: Math.round((parseInt(diskParts[2], 10) * 1024 || 0) / (1024 * 1024 * 1024)),
    usePercent: parseInt((diskParts[4] || '').replace('%',''), 10) || 0
  };
  debug('System disk: ' + JSON.stringify(systemdisk));

  // Detect all data disks under /host/
  let dataDisks = findDataFolders();
  dataDisks = dataDisks.map(p => path.basename(p));
  debug('Detected data disks: ' + JSON.stringify(dataDisks));
  /*if (dataDisks.length === 0) {
    // fallback to data1 for backward compatibility
    dataDisks = ['data1'];
  }
  */

  const datadisks = {};
  for (const disk of dataDisks) {
    const diskPath = `/host/${disk}`;
    // Use SYSTEM_COMMANDS for commands, substitute {disk} with diskPath
    const diskCmd = (commands.dataDisk).replace('{disk}', diskPath);
    const diskRaw = await execP(diskCmd);
    // du output: <blocks> <dirname>
    let used = 0;
    const duMatch = diskRaw.trim().match(/^(\d+)\s+/);
    if (duMatch) {
      used = Math.round((parseInt(duMatch[1], 10) * 1024 || 0) / (1024 * 1024 * 1024));
    }
    // Get usePercent from df
    let usePercent = null;
    if (commands.dataDiskDf) {
      const dfCmd = commands.dataDiskDf.replace('{disk}', diskPath);
      const dfRaw = await execP(dfCmd);
      let dfLines = dfRaw.trim().split('\n');
      let dfDev = dfLines.find(l => l.includes('/dev/')) || '';
      let dfParts = dfDev.split(/\s+/);
      if (dfParts.length > 4) {
        usePercent = parseInt((dfParts[4] || '').replace('%',''), 10) || 0;
      }
    }

    // Number of files
    const filesCmd = (commands.files).replace('{disk}', diskPath);
    const filesRaw = await execP(filesCmd);
    const Files = parseInt(filesRaw.trim(), 10) || 0;

    // Newest file age (seconds)
    const newestCmd = (commands.newestFile).replace('{disk}', diskPath);
    const newestRaw = await execP(newestCmd);
    let AgeFile = null;
    if (newestRaw) {
      const ts = parseFloat(newestRaw.split(' ')[0]);
      if (!isNaN(ts)) AgeFile = Math.round(Date.now()/1000 - ts);
    }

    datadisks[disk] = {
      used,
      usePercent,
      Files,
      AgeFile
    };
  }

  // Uptime
  let uptimeSeconds = null;
  uptimeSeconds = parseInt((await execP(commands.uptime)).toString().trim(), 10);


  const loadRaw = await execP(commands.load);
  debug('Load raw: ' + loadRaw);
  
  let load1 = null, load5 = null, load15 = null;
  // Try to match 'up 11 days, 5 min,'
  // Refactored: use a pattern array for switch-like matching
  
  

  // Match first three float values (load averages) in the string
  const loadMatch = loadRaw.match(/([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/);
  if (loadMatch) {
    load1 = parseFloat(loadMatch[1]);
    load5 = parseFloat(loadMatch[2]);
    load15 = parseFloat(loadMatch[3]);
  }

  // Temperature: use 'sensors -j' and parse JSON
  let temperature = null;
  try {
    const sensorsRaw = await execP('sensors -j');
    debug('sensors -j raw: ' + sensorsRaw);
    const sensorsJson = JSON.parse(sensorsRaw);
    // Try cpu_thermal-virtual-0 (Raspberry Pi)
    if (sensorsJson['cpu_thermal-virtual-0'] && sensorsJson['cpu_thermal-virtual-0'].temp1 && typeof sensorsJson['cpu_thermal-virtual-0'].temp1.temp1_input === 'number') {
      temperature = sensorsJson['cpu_thermal-virtual-0'].temp1.temp1_input;
    } else if (sensorsJson['k10temp-pci-00c3'] && sensorsJson['k10temp-pci-00c3'].Tctl && typeof sensorsJson['k10temp-pci-00c3'].Tctl.temp1_input === 'number') {
      // Try k10temp-pci-00c3 (AMD x86)
      temperature = sensorsJson['k10temp-pci-00c3'].Tctl.temp1_input;
    } else {
      // Fallback: find first temp*_input in any device
      outer: for (const dev of Object.values(sensorsJson)) {
        for (const sub of Object.values(dev)) {
          if (sub && typeof sub === 'object') {
            for (const [k, v] of Object.entries(sub)) {
              if (/^temp\d+_input$/.test(k) && typeof v === 'number') {
                temperature = v;
                break outer;
              }
            }
          }
        }
      }
    }
    debug('Parsed temperature: ' + temperature);
  } catch (e) {
    debug('Error parsing sensors -j: ' + e);
  }

  // Memory
  const memRaw = await execP(commands.memory);
  debug('Memory raw:\n' + memRaw);
  let memLines = memRaw.trim().split('\n');
  let memLine = memLines.find(l => l.startsWith('Mem:'));
  let memParts = memLine ? memLine.split(/\s+/) : [];
  const memTotal = parseInt(memParts[1], 10) * 1024 || 0;
  const memTotalGB = Math.round((parseInt(memParts[1], 10) * 1024 || 0) / (1024 * 1024 * 1024));
  const memUsedGB = Math.round((parseInt(memParts[2], 10) * 1024 || 0) / (1024 * 1024 * 1024));
  const memUsedPct = memTotalGB ? Math.round((memUsedGB / memTotalGB) * 100) : 0;
  const memory = { total: memTotalGB, used: memUsedGB, usedPercent: memUsedPct };
  debug('Memory parsed: ' + JSON.stringify(memory));

  const exportData = {
    datadisks,
    uptime: uptimeSeconds,
    load1,
    load5,
    load15,
    temperature,
    systemdisk,
    memory,
    ...(battery !== null ? { battery } : {})
  };
  debug('Export JSON: ' + JSON.stringify(exportData, null, 2));
  return exportData;
}

export { collect };

