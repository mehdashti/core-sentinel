// SPDX-License-Identifier: GPL-2.0-or-later
// One snapshot of everything Core Sentinel shows, read concurrently.

import {CpuSampler} from './cpu.js';
import {readPressure} from './pressure.js';
import {readMemory} from './memory.js';
import {StorageSampler} from './storage.js';
import {listGpus, readGpu} from './gpu.js';
import {scanHwmon, readChips} from './hwmon.js';
import {monotonicSeconds} from './io.js';

// Sensor chips and GPUs rarely change after boot, but a driver can load late
// (it87, a USB device); look for new ones once a minute.
const RESCAN_SECONDS = 60;

export class Monitor {
    constructor() {
        this._cpu = new CpuSampler();
        this._storage = new StorageSampler();
        this._chips = [];
        this._gpus = [];
        this._scannedAt = 0;
    }

    async init() {
        await Promise.all([this._cpu.init(), this._rescan()]);
    }

    async _rescan() {
        const [chips, gpus] = await Promise.all([scanHwmon(this._chips), listGpus(this._gpus)]);
        this._chips = chips;
        this._gpus = gpus;
        this._scannedAt = monotonicSeconds();
    }

    /** @returns {Promise<object>} {time, cpu, pressure, memory, storage, chips, gpus} */
    async sample() {
        if (monotonicSeconds() - this._scannedAt > RESCAN_SECONDS)
            await this._rescan();
        const chips = this._chips;
        const gpus = this._gpus;
        const [cpu, pressure, memory, storage, chipReads, gpuReads] = await Promise.all([
            this._cpu.sample(),
            readPressure(),
            readMemory(),
            this._storage.sample(),
            readChips(chips),
            Promise.all(gpus.map(readGpu)),
        ]);
        return {
            time: monotonicSeconds(),
            cpu,
            pressure,
            memory,
            storage,
            chips: chips.map((chip, i) => ({...chip, ...chipReads[i]})),
            gpus: gpus.map((gpu, i) => ({...gpu, ...gpuReads[i]})),
        };
    }
}
