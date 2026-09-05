'use strict';

// Keep the sheet and installer on the same compatibility policy. A copied
// nvngx DLL alone does not prove that the game has native NGX calls.
(function (root) {
  function nativeDlssPresent(scan) {
    const file = scan.primaryDlss;
    if (!file) return false;
    const rel = file.rel.replace(/\\/g, '/').toLowerCase();
    return !((scan.install && scan.install.added) || []).some(item => item.replace(/\\/g, '/').toLowerCase() === rel);
  }
  function optiReason(target, api = target && target.api) {
    if (!target || target.bitness !== 64 || target.emulator) return 'optiUnsupported';
    if (!['dxgi', 'vulkan'].includes(api) || target.apiLabel === 'DirectX 10') return 'optiUnsupported';
    if (!target.hasNativeDlss) return 'optiNeedsDlss';
    return null;
  }
  function routesFor(target, api = target && target.api) {
    if (!target || ![32, 64].includes(target.bitness)) return [];
    if (api === 'd3d10' || (api === 'dxgi' && target.apiLabel === 'DirectX 10')) return [];
    if (api === 'd3d8') return target.bitness === 32 ? ['feeder'] : [];
    if (['d3d9', 'opengl', 'vulkan'].includes(api)) return !optiReason(target, api) ? ['feeder', 'optiscaler'] : ['feeder'];
    if (api !== 'dxgi') return [];
    const isDx12 = target.dx12 || target.apiLabel === 'DirectX 12' ||
      (['DirectX 11/12', 'DirectX (DXGI)'].includes(target.apiLabel) && Boolean(target.hasNativeDlss));
    const routes = target.bitness === 32 || target.emulator || !isDx12 ? ['feeder'] : ['native', 'feeder'];
    if (!optiReason(target, api)) routes.push('optiscaler');
    return routes;
  }
  function recommendedRoute(scan, target = scan.chosen) {
    const nativeDlss = nativeDlssPresent(scan);
    const effectiveTarget = target ? { ...target, hasNativeDlss: target.hasNativeDlss ?? nativeDlss } : target;
    const routes = routesFor(effectiveTarget);
    const wanted = scan.install && scan.install.route === 'feeder'
      ? 'feeder' : nativeDlss ? 'native' : 'feeder';
    return routes.includes(wanted) ? wanted : (routes[0] || null);
  }
  const api = { routesFor, recommendedRoute, nativeDlssPresent, optiReason };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.installRoutes = api;
})(typeof window !== 'undefined' ? window : globalThis);
