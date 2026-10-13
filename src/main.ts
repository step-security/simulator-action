import * as core from '@actions/core'
import * as semver from 'semver'
import {deviceToString, getDevices, simctl} from './xcrun.js'
import {waitForSettle} from './settle.js'
import fs from 'fs'
import axios, {isAxiosError} from 'axios'

async function validateSubscription() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'futureware-tech/simulator-action'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'

  core.info('')
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false)
    core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m')
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`)
  core.info('')

  if (repoPrivate === false) return

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body: Record<string, string> = {action: action || ''}
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`
      )
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`
      )
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}

function parseBoolean(value: string | undefined): boolean {
  return /^(true|t|yes|y|1)$/i.test(value?.trim() || '')
}

async function run(): Promise<void> {
  try {
    await validateSubscription()
    const model = core.getInput('model')?.trim()?.toLowerCase()
    let os = core.getInput('os')?.trim()?.toLowerCase()
    const os_version = core.getInput('os_version')?.trim()
    const udid = core.getInput('udid')?.trim()?.toLowerCase()

    if (!udid && !os && !os_version && !model) {
      // Give a reasonable default, otherwise we may end up with tvOS, which is
      // unlikely to be a good guess.
      os = 'ios'
    }

    const matchingDevices = (await getDevices()).filter(device => {
      core.debug(`- ${deviceToString(device)}`)

      if (udid && device.udid.toLowerCase() !== udid) {
        core.debug('UDID does not match the request')
        return false
      }
      if (model && device.model.toLowerCase() !== model) {
        core.debug('Model does not match the request')
        return false
      }
      if (os && device.os.toLowerCase() !== os) {
        core.debug('OS does not match the request')
        return false
      }
      if (os_version) {
        const device_os_version = semver.coerce(device.os_version)
        if (
          !device_os_version ||
          !semver.satisfies(device_os_version, os_version)
        ) {
          core.debug('OS version does not match the request')
          return false
        }
      }

      return true
    })

    if (!matchingDevices.length) {
      core.setFailed(
        'No devices found for the matching requirements. See ' +
          'https://github.com/step-security/simulator-action/wiki for the ' +
          'list of available devices'
      )
      return
    }

    if (matchingDevices.length > 1) {
      core.warning(
        `More than one (${matchingDevices.length}) device matching ` +
          `requirements ` +
          `(os:[${os}] os_version:[${os_version}] model:[${model}]) ` +
          'have been found.'
      )
    }

    const device = matchingDevices[0]
    core.info(`Picked a device: ${deviceToString(device)}`)

    if (device.state !== 'Shutdown') {
      core.warning(
        `Device currently in state: ${device.state}, shutting down first...`
      )
      await simctl('shutdown', device.udid)
    }

    if (parseBoolean(core.getInput('erase_before_boot'))) {
      core.info(`Erasing device...`)
      await simctl('erase', device.udid)
    }

    if (parseBoolean(core.getInput('shutdown_after_job'))) {
      core.saveState('udid', device.udid)
    }
    core.info(`Booting device.`)
    await simctl('boot', device.udid)

    if (parseBoolean(core.getInput('wait_for_boot'))) {
      const bootTimeoutSeconds = Number(core.getInput('boot_timeout_seconds'))
      const bootRetries = Number(core.getInput('boot_retries'))

      const bootTimeoutMs =
        bootTimeoutSeconds > 0 ? bootTimeoutSeconds * 1000 : undefined

      core.info(`Waiting for device to finish booting.`)
      const maxAttempts = bootRetries + 1
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await simctl('bootstatus', device.udid, {timeoutMs: bootTimeoutMs})
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          core.warning(
            `Bootstatus attempt ${attempt}/${maxAttempts} failed: ${message}`
          )
          if (attempt === maxAttempts) {
            throw error
          }
          core.warning(`Retrying simulator boot...`)
          await simctl('shutdown', device.udid)
          await simctl('boot', device.udid)
        }
      }
    }

    const settleTimeoutSeconds = Number(
      core.getInput('settle_timeout_seconds') || '0'
    )
    if (settleTimeoutSeconds > 0) {
      core.info(
        'Waiting for the Simulator to settle (background daemons to finish starting).'
      )
      await waitForSettle({
        udid: device.udid,
        cpuThresholdPercent: Number(
          core.getInput('settle_cpu_threshold_percent')
        ),
        consecutiveSamples: Number(core.getInput('settle_consecutive_samples')),
        checkIntervalMs:
          Number(core.getInput('settle_check_interval_seconds')) * 1000,
        timeoutMs: settleTimeoutSeconds * 1000
      })
    }

    core.setOutput('udid', device.udid)
  } catch (error) {
    let errorMessage = 'Failed to run simulator-action (reason unknown)'
    if (error instanceof Error) {
      errorMessage = error.message
    }
    core.setFailed(errorMessage)
  }
}

async function cleanup(): Promise<void> {
  try {
    const udid = core.getState('udid')
    if (udid) {
      core.info(`Shutting down device ${udid}.`)
      await simctl('shutdown', udid)
    }
  } catch (error) {
    let errorMessage = 'Failed to cleanup simulator-action (reason unknown)'
    if (error instanceof Error) {
      errorMessage = error.message
    }
    core.setFailed(errorMessage)
  }
}

if (core.getState('post')) {
  await cleanup()
} else {
  core.saveState('post', 'true')
  await run()
}
