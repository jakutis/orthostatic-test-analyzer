# Orthostatic Test Analyzer

Orthostatic Test Analyzer takes the latest Orthostatic Test activity from Garmin Connect, analyzes it and sends the result to InfluxDB and intervals.icu

The activity must contain HRV data, therefore a heart rate strap is required.
The activity must have at least 5 laps.
The first one is interpreted as lying down and getting the heart rate down to whatever threshold one defines.
The second - stabilizing the heart rate.
The third - measuring the heart rate and HRV while lying.
The fourth - standing up and stabilizing the heart rate.
The fifth - measuring the heart rate and HRV while standing.

## Usage

```shell
npm install -g orthostatic-test-analyzer
orthostatic-test-analyzer path/to/config/file
```

## Example config file

```json
{
  "grafanaUrl": "http://hostname:8086",
  "grafanaToken": "abc12abc12abc12abc12abc1233333abc123",
  "grafanaOrganization": "someorg",
  "grafanaBucket": "somebucket",
  "intervalsIcuKey": "key",
  "intervalsIcuAthlete": "i12345",
  "garminActivityName": "Orthostatic Test",
  "garminSessionFile": "/home/username/.garminSession",
  "garminLastKnownActivityFile": "/home/username/.garminLastKnownActivity",
  "garminCredentials": {
    "username": "user@example.org",
    "password": "g00dpassw0rd"
  }
}
```
