import { access, constants as fsConstants, rm, readdir, readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { InfluxDB, Point } from '@influxdata/influxdb-client'
import { GarminConnect } from 'garmin-connect'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'

interface FitLap { timestamp: Date, startTime: Date, totalElapsedTime: number }

interface Lap {start: number, finish: number, duration: number, rrs: number[], avgHR: number, rmssd: number}

const rmssd = (array: number[]): number => {
  let sum = 0
  for (let i = 1; i < array.length; i++) {
    const diff = array[i] - array[i - 1]
    sum += diff * diff
  }
  return Math.sqrt(sum / (array.length - 1))
}

const readLaps = (fitLaps: FitLap[], rrs: number[]): Lap[] => fitLaps.reduce(({ laps, lapsDuration, rrs, rrDuration }, { totalElapsedTime }, i) => {
  const start = i > 0 ? laps[i - 1].finish : 0
  const duration = Math.round(totalElapsedTime * 1000)
  const finish = start + duration
  lapsDuration += duration
  let rrCount = 0
  while (true) {
    const rr = rrs[rrCount]
    if ((rrDuration + rr) <= lapsDuration) {
      rrDuration += rr
      rrCount++
    } else {
      break
    }
  }
  const lapRRs = rrs.slice(0, rrCount)
  const minuteDuration = duration / (60 * 1000)
  const avgHR = lapRRs.length / minuteDuration
  return { rrDuration, rrs: rrs.slice(rrCount), lapsDuration, laps: laps.concat({ avgHR, rmssd: rmssd(lapRRs), rrs: lapRRs, start, finish, duration }) }
}, { laps: [] as Lap[], rrs, rrDuration: 0, lapsDuration: 0 }).laps

const read = (fitLaps: FitLap[], hrv: Array<{ time: Array<number | null> }>, sessions: Array<{ event: string, eventType: string, startTime: Date }>): {
  start: number
  measurements: Array<{
    type: 'moreThanMax' | 'lyingStabilization' | 'lying' | 'standingStabilization' | 'standing'
    lap: Lap
  }>
} => {
  const session = sessions.find(({ event, eventType }) => event === 'lap' && eventType === 'stop')
  if (session === undefined) {
    throw new Error('session not found')
  }
  const { startTime } = session
  const rrs: number[] = hrv.flatMap(({ time }) => time.flatMap(time => time === null ? [] : [Math.round(time * 1000)]))
  const [moreThanMax, lyingStabilization, lying, standingStabilization, standing] = readLaps(fitLaps, rrs)
  return {
    start: startTime.getTime(),
    measurements: [
      {
        type: 'moreThanMax',
        lap: moreThanMax
      },
      {
        type: 'standingStabilization',
        lap: standingStabilization
      },
      {
        type: 'standing',
        lap: standing
      },
      {
        type: 'lying',
        lap: lying
      },
      {
        type: 'lyingStabilization',
        lap: lyingStabilization
      }
    ]
  }
}

const downloadLatestActivity = async (activityName: string, dir: string, sessionFile: string, garminConfigFile: string): Promise<void> => {
  const GCClient = new GarminConnect()
  const { username, password } = JSON.parse(String(await readFile(garminConfigFile)))
  GCClient.onSessionChange((session) => {
    writeFile(sessionFile, JSON.stringify(session)).catch(err => { console.log({ err }) })
  })
  let session: any = {}
  try {
    session = JSON.parse(String(await readFile(sessionFile)))
  } catch {
  }
  await GCClient.restoreOrLogin(session, username, password)

  for (let i = 0; ; i++) {
    const activities = await GCClient.getActivities(i, 1)
    for (const activity of activities) {
      if (activity.activityName === activityName) {
        await GCClient.downloadOriginalActivityData(activity, dir)
        return
      }
    }
  }
}

const getFirstFile = async (dir: string, suffix: string): Promise<string | undefined> => {
  for (const entry of await readdir(dir)) {
    if (entry.toLowerCase().endsWith(suffix)) {
      return entry
    }
  }
}

const getFit = async (dir: string): Promise<Buffer> => {
  const zipFile = await getFirstFile(dir, '.zip')
  if (zipFile === undefined) {
    throw new Error('zip not found')
  }
  const zip = await JSZip.loadAsync(await readFile(join(dir, zipFile)))
  const fitFile = Object.keys(zip.files).find(f => f.toLowerCase().endsWith('.fit'))
  if (fitFile === undefined) {
    throw new Error('fit not found')
  }
  const fit = zip.files[fitFile]
  const bytes = await fit.async('nodebuffer')
  return bytes
}

export const cli: () => Promise<void> = async () => {
  console.log('Orthostatic Test Analyzer\n')

  const configFile = process.argv[2]
  await access(configFile, fsConstants.R_OK)
  const {
    grafanaUrl,
    grafanaToken,
    grafanaOrganization,
    grafanaBucket,
    garminActivityName,
    garminSessionFile
  } = JSON.parse(String(await readFile(configFile)))

  const garminConfigFile = './garmin.config.json'
  await access(garminConfigFile, fsConstants.R_OK)
  const dir = await mkdtemp(join(tmpdir(), 'ota-'))
  await downloadLatestActivity(garminActivityName, dir, garminSessionFile, garminConfigFile)
  const bytes = await getFit(dir)
  await rm(dir, { recursive: true })
  console.log('Measurement taken.')

  const { Decoder, Stream } = await import('@garmin-fit/sdk')

  const stream = Stream.fromByteArray(bytes)
  const isFit = String(Decoder.isFIT(stream))
  if (isFit !== 'true') {
    throw new Error('not fit')
  }

  const decoder = new Decoder(stream)
  const integrity = String(decoder.checkIntegrity())
  if (integrity !== 'true') {
    throw new Error('bad integrity')
  }

  const { messages: { hrvMesgs: hrv, lapMesgs: laps, sessionMesgs: session }, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: false
  })

  if (errors.length !== 0) {
    throw new Error('there are errors')
  }

  const result = read(laps, hrv, session)
  console.log('Measurement analyzed.')

  const writeApi = new InfluxDB({ url: grafanaUrl, token: grafanaToken }).getWriteApi(grafanaOrganization, grafanaBucket, 'ns')
  for (const measurement of result.measurements) {
    const point = new Point('orthostatic_test')
      .tag('phase', measurement.type)
      .floatField('hr', measurement.lap.avgHR)
      .floatField('rmssd', measurement.lap.rmssd)
      .uintField('duration', measurement.lap.duration)
      .timestamp(new Date(result.start + measurement.lap.finish))
    writeApi.writePoint(point)
  }
  await writeApi.close()
  console.log('Measurement sent.')
}
