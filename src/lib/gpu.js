// SPDX-License-Identifier: GPL-2.0-or-later
// GPUs whose driver exposes a busy counter in sysfs (amdgpu today). Temperature,
// fan and power come from the GPU's hwmon chip (see hwmon.js), matched by PCI
// slot. A GPU in runtime suspend is reported as asleep and NOT read: polling a
// sleeping laptop dGPU would wake it and drain the battery.

import {readText, readNumber, listDir, linkTargetName} from './io.js';

const PCI_IDS_PATHS = ['/usr/share/misc/pci.ids', '/usr/share/hwdata/pci.ids'];

/**
 * @param {string} ids contents of pci.ids
 * @param {string} vendor 4 lowercase hex digits
 * @param {string} device 4 lowercase hex digits
 * @returns {string|null}
 */
export function pciDeviceName(ids, vendor, device) {
    const start = ids.indexOf(`\n${vendor}  `);
    if (start < 0)
        return null;
    const rest = ids.slice(start + 1);
    const next = rest.slice(1).search(/\n[0-9a-f]{4} {2}/);
    const block = next < 0 ? rest : rest.slice(0, next + 1);
    const match = new RegExp(`\\n\\t${device} {2}(.+)`).exec(block);
    return match ? match[1].trim() : null;
}

/**
 * The marketing name, and of several alternatives only the last (the retail
 * line): "Lexa PRO [Radeon 540/550 / RX 540X/550]" -> "RX 540X/550".
 */
export function shortGpuName(name) {
    const match = /\[([^\]]+)\]\s*$/.exec(name);
    const marketing = match ? match[1] : name;
    return marketing.split(' / ').pop().trim();
}

function hex4(text) {
    return text?.trim().toLowerCase().replace(/^0x/, '').padStart(4, '0') ?? null;
}

/** @returns {Promise<object[]>} {card, slot, dir, name} per supported GPU */
export async function listGpus() {
    const cards = (await listDir('/sys/class/drm'))
        .filter(n => /^card\d+$/.test(n))
        .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
    const gpus = [];
    for (const card of cards) {
        const dir = `/sys/class/drm/${card}/device`;
        // listing the directory and reading vendor/device ids never wakes the GPU
        if (!(await listDir(dir)).includes('gpu_busy_percent'))
            continue;
        const [vendor, device] = await Promise.all([readText(`${dir}/vendor`), readText(`${dir}/device`)]);
        gpus.push({card, slot: linkTargetName(dir) ?? card, dir, vendor: hex4(vendor), device: hex4(device)});
    }
    if (gpus.length === 0)
        return gpus;

    let ids = null;
    for (const path of PCI_IDS_PATHS) {
        ids = await readText(path);
        if (ids)
            break;
    }
    for (const gpu of gpus) {
        const name = ids && gpu.vendor && gpu.device ? pciDeviceName(ids, gpu.vendor, gpu.device) : null;
        gpu.name = name ? shortGpuName(name) : `GPU ${gpu.slot}`;
    }
    return gpus;
}

/** @returns {Promise<{asleep: boolean, busy: number|null, vramUsed: number|null, vramTotal: number|null}>} */
export async function readGpu(gpu) {
    if ((await readText(`${gpu.dir}/power/runtime_status`))?.trim() === 'suspended')
        return {asleep: true, busy: null, vramUsed: null, vramTotal: null};
    const [busy, vramUsed, vramTotal] = await Promise.all([
        readNumber(`${gpu.dir}/gpu_busy_percent`),
        readNumber(`${gpu.dir}/mem_info_vram_used`),
        readNumber(`${gpu.dir}/mem_info_vram_total`),
    ]);
    return {asleep: false, busy, vramUsed, vramTotal};
}
