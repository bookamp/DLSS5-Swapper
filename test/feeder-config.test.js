'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/core/feeder-config');

test('32-bit ReShade configuration preserves user settings and orders the feeder', () => {
  const ini = config.configureGameReShade([
    '[GENERAL]',
    'PresetPath=.\\Custom.ini',
    'EffectSearchPaths=.\\reshade-shaders\\Shaders\\**\\**,D:\\MyShaders\\**',
    'TextureSearchPaths=.\\reshade-shaders\\Textures\\**\\**',
    'PreprocessorDefinitions=OLD_SETTING=1,DLSS5_MV_PROVIDER=0',
    'PerformanceMode=1',
    '',
    '[ADDON]',
    'AddonPath=.\\addons'
  ].join('\r\n'));
  assert.match(ini, /^PresetPath=\.\\Custom\.ini$/m);
  assert.match(ini, /^PerformanceMode=1$/m);
  assert.match(ini, /^EffectSearchPaths=\.\\reshade-shaders\\Shaders\\\*\*,D:\\MyShaders\\\*\*$/m);
  assert.match(ini, /^TextureSearchPaths=\.\\reshade-shaders\\Textures\\\*\*$/m);
  assert.doesNotMatch(ini, /\\\*\*\\\*\*/);
  assert.match(ini, /^PreprocessorDefinitions=DLSS5_MV_PROVIDER=2,OLD_SETTING=1$/m);
  assert.match(ini, /^AddonPath=\.\\$/m);

  const preset = config.configurePreset([
    'Techniques=Existing@Other.fx,DLSS5_Feed@DLSS5_Feed.fx',
    'TechniqueSorting=Existing@Other.fx',
    'PreprocessorDefinitions=SOMETHING=7,DLSS5_MV_PROVIDER=0'
  ].join('\r\n'));
  assert.match(preset, /^Techniques=vort_MotionEffects@vort_Motion\.fx,DLSS5_Feed@DLSS5_Feed\.fx,Existing@Other\.fx$/m);
  assert.match(preset, /^TechniqueSorting=vort_MotionEffects@vort_Motion\.fx,DLSS5_Feed@DLSS5_Feed\.fx,Existing@Other\.fx$/m);
  assert.match(preset, /^PreprocessorDefinitions=DLSS5_MV_PROVIDER=2,SOMETHING=7$/m);
});

test('dgVoodoo configuration enables the D3D9 to D3D11 route', () => {
  const output = config.configureDgVoodoo('[General]\r\nOutputAPI=bestavailable\r\n\r\n[DirectX]\r\nVRAM=256\r\n');
  assert.match(output, /^OutputAPI=d3d11_fl11_0$/m);
  assert.match(output, /^CaptureMouse=false$/m);
  assert.match(output, /^DisableAndPassThru=false$/m);
  assert.match(output, /^VRAM=1024$/m);
  assert.match(output, /^dgVoodooWatermark=false$/m);
});
