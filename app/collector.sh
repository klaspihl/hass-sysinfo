#!/usr/bin/env sh
set -eu

mountPoint="${MOUNT_POINT:-${mount_point:-/}}"
mountPointsCsv="${MOUNT_POINTS:-${mount_points:-$mountPoint}}"
mountFileAgeCsv="${MOUNT_FILEAGE:-${mount_fileage:-}}"
excludedFsRegex="${EXCLUDED_FS_REGEX:-tmpfs|overlay|squashfs}"
exporterPort="${EXPORTER_PORT:-9100}"

trim_value() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

mount_suffix_from_path() {
  cleanedPath="$1"
  while [ "$cleanedPath" != "/" ] && [ "${cleanedPath%/}" != "$cleanedPath" ]; do
    cleanedPath="${cleanedPath%/}"
  done
  if [ -z "$cleanedPath" ] || [ "$cleanedPath" = "/" ]; then
    printf 'Root'
    return
  fi
  suffix="${cleanedPath##*/}"
  suffix="$(printf '%s' "$suffix" | tr -cd '[:alnum:]')"
  if [ -z "$suffix" ]; then
    suffix="Mount"
  fi
  printf '%s' "$suffix"
}

fileAgeFields=""
if [ -n "$mountFileAgeCsv" ]; then
  nowEpoch="$(date -u +%s)"
  printf '%s\n' "$mountFileAgeCsv" | tr ',' '\n' | while IFS= read -r mountPathRaw; do
    mountPath="$(trim_value "$mountPathRaw")"
    if [ -z "$mountPath" ]; then
      continue
    fi

    suffix="$(mount_suffix_from_path "$mountPath")"
    hostPath="/host${mountPath}"

    ageSecondsJson="null"

    if [ -d "$hostPath" ] || [ -f "$hostPath" ]; then
      latestEpoch="$(find "$hostPath" -xdev -type f -exec stat -c '%Y' {} + 2>/dev/null | sort -n | tail -n1 || true)"
      if [ -n "$latestEpoch" ]; then
        latestEpochInt="$latestEpoch"
        ageSeconds=$((nowEpoch - latestEpochInt))
        if [ "$ageSeconds" -lt 0 ]; then
          ageSeconds=0
        fi
        ageSecondsJson="$ageSeconds"
      fi
    fi

    printf '"mountFileAgeRequested%s":"%s",' "$suffix" "$mountPath"
    printf '"mountFileAgeSeconds%s":%s,' "$suffix" "$ageSecondsJson"
  done > /tmp/file_age_fields.jsonfrag
  fileAgeFields="$(cat /tmp/file_age_fields.jsonfrag)"
  rm -f /tmp/file_age_fields.jsonfrag
fi

/usr/local/bin/node_exporter \
  --path.rootfs=/host \
  --path.procfs=/host/proc \
  --path.sysfs=/host/sys \
  --collector.cpu \
  --collector.loadavg \
  --collector.filesystem \
  --collector.hwmon \
  --collector.powersupplyclass \
  '--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run|var/lib/docker/.+|var/lib/containerd/.+)($|/)' \
  --log.level=error \
  --web.listen-address="127.0.0.1:${exporterPort}" \
  >/dev/null 2>&1 &
exporterPid=$!

cleanup() {
  kill "$exporterPid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

metricsText=""
attempt=0
while [ "$attempt" -lt 20 ]; do
  if metricsText="$(wget -qO- "http://127.0.0.1:${exporterPort}/metrics" 2>/dev/null)" && [ -n "$metricsText" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.5
done

if [ -z "$metricsText" ]; then
  echo '{"error":"node_exporter metrics unavailable"}'
  exit 1
fi

generatedAt="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

printf '%s\n' "$metricsText" | awk \
  -v mountPointsCsv="$mountPointsCsv" \
  -v mountFileAgeCsv="$mountFileAgeCsv" \
  -v excludedFsRegex="$excludedFsRegex" \
  -v fileAgeFields="$fileAgeFields" \
  -v generatedAt="$generatedAt" '
function labelValue(metric, key,   pattern, start, rest, end, value) {
  pattern = key "=\""
  start = index(metric, pattern)
  if (start == 0) {
    return ""
  }
  rest = substr(metric, start + length(pattern))
  end = index(rest, "\"")
  if (end == 0) {
    return ""
  }
  value = substr(rest, 1, end - 1)
  return value
}

function metricName(token,   bracePos) {
  bracePos = index(token, "{")
  if (bracePos == 0) {
    return token
  }
  return substr(token, 1, bracePos - 1)
}

function trimValue(text) {
  gsub(/^[ \t]+|[ \t]+$/, "", text)
  return text
}

function mountSuffixFromPath(path,   cleaned, partCount, parts, suffix) {
  cleaned = path
  gsub(/\/+$/, "", cleaned)
  if (cleaned == "" || cleaned == "/") {
    return "Root"
  }
  partCount = split(cleaned, parts, "/")
  suffix = parts[partCount]
  gsub(/[^A-Za-z0-9]/, "", suffix)
  if (suffix == "") {
    return "Mount"
  }
  return suffix
}

BEGIN {
  split(mountFileAgeCsv, fileAgeParts, ",")
  for (fileAgePartIndex in fileAgeParts) {
    fileAgeCandidate = trimValue(fileAgeParts[fileAgePartIndex])
    if (fileAgeCandidate == "") {
      continue
    }
    fileCountRequestedByMount[fileAgeCandidate] = 1
  }

  mountPointCount = 0
  split(mountPointsCsv, mountParts, ",")
  for (mountPartIndex in mountParts) {
    mountCandidate = trimValue(mountParts[mountPartIndex])
    if (mountCandidate == "") {
      continue
    }
    if (seenMount[mountCandidate]) {
      continue
    }
    seenMount[mountCandidate] = 1
    mountPointCount += 1
    requestedMountPoint[mountPointCount] = mountCandidate

    suffix = mountSuffixFromPath(mountCandidate)
    suffixCount[suffix] += 1
    if (suffixCount[suffix] > 1) {
      suffix = suffix suffixCount[suffix]
    }
    mountSuffix[mountPointCount] = suffix
  }

  if (mountPointCount == 0) {
    mountPointCount = 1
    requestedMountPoint[1] = "/"
    mountSuffix[1] = "Root"
  }

  sizeRoot = 0
  availRoot = 0
  filesRoot = 0
  filesFreeRoot = 0

  memAvail = -1
  memTotal = -1

  nodeTimeSeconds = -1
  bootTimeSeconds = -1

  load1 = "null"
  load5 = "null"
  load15 = "null"

  tempSum = 0
  tempCount = 0

  batterySum = 0
  batteryCount = 0
}

/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?[[:space:]]+[-+0-9.eE]+$/ {
  token = $1
  value = $2 + 0
  name = metricName(token)

  if (name == "node_memory_MemAvailable_bytes") {
    memAvail = value
    next
  }
  if (name == "node_memory_MemTotal_bytes") {
    memTotal = value
    next
  }
  if (name == "node_time_seconds") {
    nodeTimeSeconds = value
    next
  }
  if (name == "node_boot_time_seconds") {
    bootTimeSeconds = value
    next
  }
  if (name == "node_load1") {
    load1 = value
    next
  }
  if (name == "node_load5") {
    load5 = value
    next
  }
  if (name == "node_load15") {
    load15 = value
    next
  }
  if (name == "node_hwmon_temp_celsius") {
    tempSum += value
    tempCount += 1
    next
  }

  if (name == "node_power_supply_capacity") {
    ps = labelValue(token, "power_supply")
    if (ps ~ /^BAT/) {
      batterySum += value
      batteryCount += 1
    }
    next
  }

  if (name == "node_filesystem_size_bytes" || name == "node_filesystem_avail_bytes" || name == "node_filesystem_files" || name == "node_filesystem_files_free") {
    mountpoint = labelValue(token, "mountpoint")
    fstype = labelValue(token, "fstype")

    if (fstype ~ excludedFsRegex) {
      next
    }

    for (mountIndex = 1; mountIndex <= mountPointCount; mountIndex += 1) {
      requestedPath = requestedMountPoint[mountIndex]
      if (mountpoint != requestedPath) {
        continue
      }
      foundRequestedByMount[requestedPath] = 1
      if (name == "node_filesystem_size_bytes") {
        sizeRequestedByMount[requestedPath] += value
      } else if (name == "node_filesystem_avail_bytes") {
        availRequestedByMount[requestedPath] += value
      } else if (name == "node_filesystem_files") {
        filesRequestedByMount[requestedPath] += value
      } else if (name == "node_filesystem_files_free") {
        filesFreeRequestedByMount[requestedPath] += value
      }
    }

    if (mountpoint == "/") {
      if (name == "node_filesystem_size_bytes") {
        sizeRoot += value
      } else if (name == "node_filesystem_avail_bytes") {
        availRoot += value
      } else if (name == "node_filesystem_files") {
        filesRoot += value
      } else if (name == "node_filesystem_files_free") {
        filesFreeRoot += value
      }
    }
  }
}

END {
  # Primary/base metrics are always rooted at '/'.
  primaryRequestedMountPoint = "/"
  mountPointUsed = "/"
  size = sizeRoot
  avail = availRoot
  files = filesRoot
  filesFree = filesFreeRoot

  if (size > 0) {
    diskUsageBytes = size - avail
    diskUsagePercent = 100 * (1 - (avail / size))
  } else {
    diskUsageBytes = "null"
    diskUsagePercent = "null"
  }

  if (files > 0 || filesFree > 0) {
    fileCount = files - filesFree
  } else {
    fileCount = "null"
  }

  if (memTotal > 0 && memAvail >= 0) {
    memoryUsagePercent = 100 * (1 - (memAvail / memTotal))
  } else {
    memoryUsagePercent = "null"
  }

  if (nodeTimeSeconds >= 0 && bootTimeSeconds >= 0 && nodeTimeSeconds >= bootTimeSeconds) {
    uptimeSeconds = int(nodeTimeSeconds - bootTimeSeconds)
  } else {
    uptimeSeconds = "null"
  }

  if (tempCount > 0) {
    tempAvg = tempSum / tempCount
  } else {
    tempAvg = "null"
  }

  if (batteryCount > 0) {
    batteryCapacity = batterySum / batteryCount
  } else {
    batteryCapacity = "null"
  }

  printf("{\"generatedAt\":\"%s\",\"metrics\":{", generatedAt)

  if (memoryUsagePercent == "null") {
    printf("\"memoryUsagePercent\":null,")
  } else {
    printf("\"memoryUsagePercent\":%.2g,", memoryUsagePercent)
  }

  if (memTotal > 0) {
    printf("\"memoryTotalBytes\":%.0f,", memTotal)
  } else {
    printf("\"memoryTotalBytes\":null,")
  }

  if (uptimeSeconds == "null") {
    printf("\"systemUptimeSeconds\":null,")
  } else {
    printf("\"systemUptimeSeconds\":%.0f,", uptimeSeconds)
  }

  # Always expose explicit root-named keys.
  printf("\"mountPointRequestedRoot\":\"/\",")
  printf("\"mountPointUsedRoot\":\"/\",")

  if (diskUsageBytes == "null") {
    printf("\"DiskUsageBytesRoot\":null,")
  } else {
    printf("\"DiskUsageBytesRoot\":%.15g,", diskUsageBytes)
  }

  if (size > 0) {
    printf("\"DiskSizeBytesRoot\":%.0f,", size)
  } else {
    printf("\"DiskSizeBytesRoot\":null,")
  }

  if (diskUsagePercent == "null") {
    printf("\"DiskUsagePercentRoot\":null,")
  } else {
    printf("\"DiskUsagePercentRoot\":%.2g,", diskUsagePercent)
  }

  if (fileCountRequestedByMount["/"]) {
    if (fileCount == "null") {
      printf("\"FileCountRoot\":null,")
    } else {
      printf("\"FileCountRoot\":%.15g,", fileCount)
    }
  }

  for (mountIndex = 1; mountIndex <= mountPointCount; mountIndex += 1) {
    requestedPath = requestedMountPoint[mountIndex]
    suffix = mountSuffix[mountIndex]

    # Root is already emitted via base metrics and Root keys.
    if (requestedPath == "/") {
      continue
    }

    resolvedPath = requestedPath

    mountSize = sizeRequestedByMount[requestedPath]
    mountAvail = availRequestedByMount[requestedPath]
    mountFiles = filesRequestedByMount[requestedPath]
    mountFilesFree = filesFreeRequestedByMount[requestedPath]

    if (!foundRequestedByMount[requestedPath] || mountSize <= 0) {
      resolvedPath = "/"
      mountSize = sizeRoot
      mountAvail = availRoot
      mountFiles = filesRoot
      mountFilesFree = filesFreeRoot
    }

    if (mountSize > 0) {
      mountDiskBytes = mountSize - mountAvail
      mountDiskPercent = 100 * (1 - (mountAvail / mountSize))
    } else {
      mountDiskBytes = "null"
      mountDiskPercent = "null"
    }

    if (mountFiles > 0 || mountFilesFree > 0) {
      mountFileCount = mountFiles - mountFilesFree
    } else {
      mountFileCount = "null"
    }

    printf("\"mountPointRequested%s\":\"%s\",", suffix, requestedPath)
    printf("\"mountPointUsed%s\":\"%s\",", suffix, resolvedPath)

    if (mountDiskBytes == "null") {
      printf("\"DiskUsageBytes%s\":null,", suffix)
    } else {
      printf("\"DiskUsageBytes%s\":%.15g,", suffix, mountDiskBytes)
    }

    if (mountSize > 0) {
      printf("\"DiskSizeBytes%s\":%.0f,", suffix, mountSize)
    } else {
      printf("\"DiskSizeBytes%s\":null,", suffix)
    }

    if (mountDiskPercent == "null") {
      printf("\"DiskUsagePercent%s\":null,", suffix)
    } else {
      printf("\"DiskUsagePercent%s\":%.2g,", suffix, mountDiskPercent)
    }

    if (fileCountRequestedByMount[requestedPath]) {
      if (mountFileCount == "null") {
        printf("\"FileCount%s\":null,", suffix)
      } else {
        printf("\"FileCount%s\":%.15g,", suffix, mountFileCount)
      }
    }
  }

  if (fileAgeFields != "") {
    printf("%s", fileAgeFields)
  }

  printf("\"cpuLoad\":{\"1m\":")
  if (load1 == "null") { printf("null") } else { printf("%.15g", load1) }
  printf(",\"5m\":")
  if (load5 == "null") { printf("null") } else { printf("%.15g", load5) }
  printf(",\"15m\":")
  if (load15 == "null") { printf("null") } else { printf("%.15g", load15) }
  printf("},")

  if (tempAvg == "null") {
    printf("\"systemTemperatureCelsius\":null,")
  } else {
    printf("\"systemTemperatureCelsius\":%.2f,", tempAvg)
  }

  printf("\"battery\":{\"capacityPercent\":")
  if (batteryCapacity == "null") {
    printf("null")
  } else {
    printf("%.2g", batteryCapacity)
  }
  printf("}}}\n")
}
'
