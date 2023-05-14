# Orthostatic Test Analyzer

Orthostatic Test Analyzer takes the latest Orthostatic Test activity from Garmin Connect, analyzes it and sends the result to InfluxDB

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
  "garminActivityName": "Orthostatic Test",
  "garminSessionFile": "/home/username/.garminSession",
  "garminCredentials": {
    "username": "user@example.org",
    "password": "g00dpassw0rd"
  }
}
```
