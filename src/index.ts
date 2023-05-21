import { access, constants as fsConstants, rm, readdir, readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { InfluxDB, Point } from '@influxdata/influxdb-client'
import { GarminConnect } from 'garmin-connect'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'

interface FitLap { timestamp: Date, startTime: Date, totalElapsedTime: number }

interface Lap {start: number, finish: number, duration: number, rrs: number[], avgHR: number, rmssd: number}

const rmssd = (array: number[]): number => {
  if (array.length < 2) {
    return 0
  }
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
  measurementsByType: {
    moreThanMax: Lap
    standingStabilization: Lap
    standing: Lap
    lying: Lap
    lyingStabilization: Lap
  }
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
    measurementsByType: {
      moreThanMax,
      standingStabilization,
      standing,
      lying,
      lyingStabilization
    },
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

const tryOrUndefined = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn()
  } catch {}
}

const downloadLatestActivity = async (credentials: { username: string, password: string }, activityName: string, sessionFile: string, lastKnownActivityFile: string): Promise<Buffer | undefined> => {
  const lastKnownActivity = await tryOrUndefined(async () => {
    return Number(await readFile(lastKnownActivityFile))
  })
  const GCClient = new GarminConnect(credentials)
  GCClient.onSessionChange((session) => {
    writeFile(sessionFile, JSON.stringify(session)).catch(err => { console.log({ err }) })
  })
  let session: any = {}
  try {
    session = JSON.parse(String(await readFile(sessionFile)))
  } catch {
  }
  await GCClient.restoreOrLogin(session, credentials.username, credentials.password)

  let newLastKnownActivity
  let state: { type: 'searching' } | { type: 'found', bytes: Buffer } | { type: 'notfound' } = { type: 'searching' }
  for (let i = 0; ; i++) {
    if (state.type !== 'searching') {
      break
    }
    const activities = await GCClient.getActivities(i, 1)
    for (const activity of activities) {
      if (state.type !== 'searching') {
        break
      }
      if (newLastKnownActivity === undefined) {
        newLastKnownActivity = activity.activityId
      }
      if (activity.activityId === lastKnownActivity) {
        state = { type: 'notfound' }
      } else if (activity.activityName === activityName) {
        const dir = await mkdtemp(join(tmpdir(), 'ota-'))
        await GCClient.downloadOriginalActivityData(activity, dir)
        const bytes = await getFit(dir)
        await rm(dir, { recursive: true })
        state = { type: 'found', bytes }
      }
    }
  }
  await writeFile(lastKnownActivityFile, String(newLastKnownActivity))
  return state.type === 'found' ? state.bytes : undefined
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
    intervalsIcuKey,
    intervalsIcuAthlete,
    garminActivityName,
    garminSessionFile,
    garminLastKnownActivityFile,
    garminCredentials
  } = JSON.parse(String(await readFile(configFile)))

  const bytes = await downloadLatestActivity(garminCredentials, garminActivityName, garminSessionFile, garminLastKnownActivityFile)
  if (bytes == null) {
    console.log('No new activity downloaded.')
    return
  }
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
  console.log('Measurement sent to InfluxDB.')

  const date = new Date(result.start).toISOString().slice(0, 10)
  const auth = Buffer.from(`API_KEY:${String(intervalsIcuKey)}`).toString('base64')
  const url = `https://intervals.icu/api/v1/athlete/${String(intervalsIcuAthlete)}/wellness/${date}`
  const method = 'PUT'
  const body = JSON.stringify({
    OrthostaticHrLying: result.measurementsByType.lying.avgHR,
    OrthostaticHrvLying: result.measurementsByType.lying.rmssd,
    OrthostaticHrStanding: result.measurementsByType.standing.avgHR,
    OrthostaticHrvStanding: result.measurementsByType.standing.rmssd
  })
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + auth
  }
  const response = await fetch(url, {
    method,
    headers,
    body
  })
  if (response.status !== 200) {
    console.log(`Measurement sending to intervals.icu failed with status ${response.status}`)
  } else {
    console.log('Measurement sent to intervals.icu.')
  }
}
