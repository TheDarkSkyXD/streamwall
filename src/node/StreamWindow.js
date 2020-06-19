import EventEmitter from 'events'
import { BrowserView, BrowserWindow, ipcMain } from 'electron'
import { interpret } from 'xstate'

import viewStateMachine from './viewStateMachine'
import { boxesFromViewURLMap } from './geometry'

import {
  WIDTH,
  HEIGHT,
  GRID_COUNT,
  SPACE_WIDTH,
  SPACE_HEIGHT,
} from '../constants'

export default class StreamWindow extends EventEmitter {
  constructor() {
    super()
    this.win = null
    this.overlayView = null
    this.views = []
    this.viewStates = new Map()
  }

  init() {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      backgroundColor: '#000',
      useContentSize: true,
      show: false,
    })
    win.removeMenu()
    win.loadURL('about:blank')

    // Work around https://github.com/electron/electron/issues/14308
    // via https://github.com/lutzroeder/netron/commit/910ce67395130690ad76382c094999a4f5b51e92
    win.once('ready-to-show', () => {
      win.resizable = false
      win.show()
    })
    this.win = win

    const overlayView = new BrowserView({
      webPreferences: {
        nodeIntegration: true,
      },
    })
    win.addBrowserView(overlayView)
    overlayView.setBounds({
      x: 0,
      y: 0,
      width: WIDTH,
      height: HEIGHT,
    })
    overlayView.webContents.loadFile('overlay.html')
    this.overlayView = overlayView

    const actions = {
      hideView: (context, event) => {
        const { view } = context
        win.removeBrowserView(view)
      },
      positionView: (context, event) => {
        const { pos, view } = context
        win.addBrowserView(view)

        // It's necessary to remove and re-add the overlay view to ensure it's on top.
        win.removeBrowserView(overlayView)
        win.addBrowserView(overlayView)

        view.setBounds(pos)
      },
    }

    const views = []
    for (let idx = 0; idx <= 9; idx++) {
      const view = new BrowserView()
      view.setBackgroundColor('#000')

      const machine = viewStateMachine
        .withContext({
          ...viewStateMachine.context,
          view,
          parentWin: win,
          overlayView,
        })
        .withConfig({ actions })
      const service = interpret(machine).start()
      service.onTransition((state) => this.handleViewTransition(idx, state))

      views.push(service)
    }
    this.views = views

    ipcMain.on('devtools-overlay', () => {
      overlayView.webContents.openDevTools()
    })
  }

  handleViewTransition(idx, state) {
    const viewState = {
      state: state.value,
      context: {
        url: state.context.url,
        info: state.context.info,
        pos: state.context.pos,
      },
    }
    this.viewStates.set(idx, viewState)
    this.emit('state', [...this.viewStates.values()])
  }

  setViews(viewURLMap) {
    const { views } = this
    const boxes = boxesFromViewURLMap(GRID_COUNT, GRID_COUNT, viewURLMap)

    const unusedViews = new Set(views)
    for (const box of boxes) {
      const { url, x, y, w, h, spaces } = box

      if (!url) {
        continue
      }

      // TODO: prefer fully loaded views
      let space = views.find(
        (s) => unusedViews.has(s) && s.state.context.url === url,
      )
      if (!space) {
        space = views.find(
          (s) => unusedViews.has(s) && !s.state.matches('displaying'),
        )
      }
      const pos = {
        x: SPACE_WIDTH * x,
        y: SPACE_HEIGHT * y,
        width: SPACE_WIDTH * w,
        height: SPACE_HEIGHT * h,
        spaces,
      }
      space.send({ type: 'DISPLAY', pos, url })
      unusedViews.delete(space)
    }

    for (const space of unusedViews) {
      space.send('CLEAR')
    }
  }

  setListeningView(viewIdx) {
    const { views } = this
    for (const view of views) {
      if (!view.state.matches('displaying')) {
        continue
      }
      const { context } = view.state
      const isSelectedView = context.pos.spaces.includes(viewIdx)
      view.send(isSelectedView ? 'UNMUTE' : 'MUTE')
    }
  }

  send(...args) {
    this.overlayView.webContents.send(...args)
  }
}