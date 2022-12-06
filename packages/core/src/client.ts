import { interpret } from 'xstate'
import { NhostSession } from './types'
import { AuthMachine, AuthMachineOptions, createAuthMachine } from './machines'
import type { AuthInterpreter } from './types'

export type NhostClientOptions = AuthMachineOptions & {
  /** @internal create and start xstate interpreter on creation. With React, it is started inside the Nhost provider */
  start?: boolean
}

/**
 * @internal
 * This is a private API.
 */
export class AuthClient {
  readonly backendUrl: string
  readonly clientUrl: string
  private _machine: AuthMachine
  private _interpreter?: AuthInterpreter
  private _started = false
  private _channel?: BroadcastChannel
  private _subscriptionsQueue: Set<(client: AuthClient) => void> = new Set()
  private _subscriptions: Set<() => void> = new Set()

  constructor({
    clientStorageType = 'web',
    autoSignIn = true,
    autoRefreshToken = true,
    start = true,
    backendUrl,
    clientUrl,
    devTools,
    ...defaultOptions
  }: NhostClientOptions) {
    this.backendUrl = backendUrl
    this.clientUrl = clientUrl

    this._machine = createAuthMachine({
      ...defaultOptions,
      backendUrl,
      clientUrl,
      clientStorageType,
      autoSignIn,
      autoRefreshToken
    })

    if (start) {
      this.start({ devTools })
    }

    if (typeof window !== 'undefined' && autoSignIn) {
      try {
        // TODO listen to sign out
        // TODO the same refresh token is used and refreshed by all tabs
        // * Ideally, a single tab should autorefresh and share the new jwt
        this._channel = new BroadcastChannel('nhost')
        this._channel.addEventListener('message', (token) => {
          const existingToken = this.interpreter?.getSnapshot().context.refreshToken.value
          if (this.interpreter && token.data !== existingToken) {
            this.interpreter.send('TRY_TOKEN', { token: token.data })
          }
        })
      } catch (error) {
        // * BroadcastChannel is not available e.g. react-native
      }
    }
  }

  start({
    devTools = false,
    initialSession,
    interpreter
  }: { interpreter?: AuthInterpreter; initialSession?: NhostSession; devTools?: boolean } = {}) {
    const context = { ...this.machine.context }
    if (initialSession) {
      context.user = initialSession.user
      context.refreshToken.value = initialSession.refreshToken ?? null
      context.accessToken.value = initialSession.accessToken ?? null
      context.accessToken.expiresAt = new Date(
        Date.now() + initialSession.accessTokenExpiresIn * 1_000
      )
    }
    const machineWithInitialContext = this.machine.withContext(context)

    if (!this._interpreter) {
      this._interpreter = interpreter || interpret(machineWithInitialContext, { devTools })
    }

    // * Start the interpreter if not started already. Always restart the interpreter when on the server side
    if (!this._started || typeof window === 'undefined') {
      if (this._interpreter.initialized) {
        this._interpreter.stop()
        this._subscriptions.forEach((fn) => fn())
      }
      this._interpreter.start(machineWithInitialContext.initialState)
      this._subscriptionsQueue.forEach((fn) => fn(this))
    }

    this._started = true
  }

  public get machine() {
    return this._machine
  }

  get interpreter(): AuthInterpreter | undefined {
    return this._interpreter
  }

  get started(): boolean {
    return this._started
  }

  subscribe(fn: (client: AuthClient) => () => void): () => void {
    if (this.started) {
      // * The interpreter is already available: we can add the listener straight ahead
      const subscription = fn(this)
      this._subscriptions.add(subscription)
      return subscription
    } else {
      // * The interpreter is not yet available: we add the listener to a queue that will be started when setting the interpreter
      // * Note: in React, the Xstate interpreter does not start from the global state, but from the root component
      this._subscriptionsQueue.add(fn)
      return () => {
        console.log(
          'onTokenChanged was added before the interpreter started. Cannot unsubscribe listener.'
        )
      }
    }
  }
}
