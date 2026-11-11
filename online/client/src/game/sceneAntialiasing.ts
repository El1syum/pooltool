import { Vector2, type Camera, type Scene, type WebGLRenderer } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import type { PresentationSettings } from './settingsOptions'

type Mode = PresentationSettings['antialiasMode']

/**
 * Auto renders directly with the existing WebGL antialias context. The
 * alternate passes use their own unsampled targets and keep that same context,
 * canvas and input handlers intact.
 */
export function createSceneAntialiasing(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  onFallback?: (mode: Exclude<Mode, 'auto'>) => void,
) {
  const gl = renderer.getContext()
  const canvas = renderer.domElement
  const drawingSize = new Vector2()
  let requested: Mode = 'auto'
  let chain: EffectComposer | null = null
  let width = 0
  let height = 0
  canvas.dataset.antialiasMode = 'auto'

  function release() {
    if (chain) {
      // EffectComposer owns its ping-pong buffers, but not the passes.
      for (const pass of chain.passes) pass.dispose()
      chain.dispose()
      chain = null
    }
    width = height = 0
  }

  function fallback(mode: Exclude<Mode, 'auto'>) {
    release()
    canvas.dataset.antialiasMode = 'auto'
    canvas.dataset.antialiasFallback = mode
    onFallback?.(mode)
  }

  function fit(composer: EffectComposer) {
    renderer.getDrawingBufferSize(drawingSize)
    const x = Math.max(1, drawingSize.x)
    const y = Math.max(1, drawingSize.y)
    if (width === x && height === y) return
    if (gl.isContextLost() || Math.max(x, y) > renderer.capabilities.maxTextureSize) {
      throw new Error('Post-processing framebuffer size is unavailable')
    }
    composer.setSize(x, y)
    // WebGL reports framebuffer failures through status, not JS exceptions.
    // Probe only when the targets are (re)allocated, never during steady frames.
    const previous = renderer.getRenderTarget()
    try {
      for (const target of [composer.renderTarget1, composer.renderTarget2]) {
        renderer.setRenderTarget(target)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('Post-processing framebuffer is incomplete')
        }
      }
    } finally {
      renderer.setRenderTarget(previous)
    }
    width = x
    height = y
  }

  function configure(mode: Mode) {
    if (requested !== mode) {
      requested = mode
      release()
      canvas.dataset.antialiasMode = 'auto'
      delete canvas.dataset.antialiasFallback
      if (mode === 'auto') return
      try {
        // The stock composer and SMAA use linear, half-float buffers. Avoid
        // running either on devices that cannot render to that format.
        if (!renderer.extensions.has('EXT_color_buffer_float') && !renderer.extensions.has('EXT_color_buffer_half_float')) {
          fallback(mode)
          return
        }
        chain = new EffectComposer(renderer)
        // Use integer drawing-buffer dimensions below so CSS scaling, device
        // pixel ratio and render-scale changes are all applied exactly once.
        chain.setPixelRatio(1)
        chain.addPass(new RenderPass(scene, camera))
        if (mode === 'smaa') chain.addPass(new SMAAPass())
        chain.addPass(new OutputPass())
        if (mode === 'fxaa') chain.addPass(new FXAAPass())
        // SMAA works before OutputPass in linear sRGB; FXAA needs sRGB input.
      } catch {
        fallback(mode)
        return
      }
    }
    if (mode !== 'auto' && chain) {
      try {
        fit(chain)
        canvas.dataset.antialiasMode = mode
      } catch {
        fallback(mode)
      }
    }
  }

  function render() {
    if (chain && requested !== 'auto') {
      const autoReset = renderer.info.autoReset
      const autoClear = renderer.autoClear
      const previous = renderer.getRenderTarget()
      let failed = false
      // Aggregate the scene and fullscreen draw calls into the existing
      // per-frame telemetry; Three normally resets it on every render call.
      renderer.info.autoReset = false
      renderer.info.reset()
      try {
        chain.render()
      } catch {
        failed = true
      } finally {
        renderer.info.autoReset = autoReset
        renderer.autoClear = autoClear
        // EffectComposer restores the target itself on a successful frame.
        if (failed) renderer.setRenderTarget(previous)
      }
      if (!failed) return
      fallback(requested)
      renderer.info.reset()
    }
    renderer.render(scene, camera)
  }

  return { configure, render, dispose: release }
}
