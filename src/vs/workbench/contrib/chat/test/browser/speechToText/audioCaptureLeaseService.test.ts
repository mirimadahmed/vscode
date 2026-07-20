/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { TestNotificationService } from '../../../../../../platform/notification/test/common/testNotificationService.js';
import { StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../../test/common/workbenchTestServices.js';
import { AgentsVoiceStorageKeys } from '../../../../agentsVoice/common/agentsVoice.js';
import { DictationAudioCapture, encodeRawPcm16Base64 } from '../../../browser/speechToText/dictationAudioCapture.js';
import { AudioCaptureLeaseService } from '../../../browser/voiceClient/audioCaptureLeaseService.js';
import { MicCaptureService } from '../../../browser/voiceClient/micCaptureService.js';

suite('Dictation audio capture', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createWindow(getUserMedia: () => Promise<MediaStream>): Window & typeof globalThis {
		const mediaDevices = { getUserMedia } as Partial<MediaDevices> as MediaDevices;
		const navigator = new Proxy(mainWindow.navigator, {
			get(target, property, receiver) {
				return property === 'mediaDevices' ? mediaDevices : Reflect.get(target, property, receiver);
			}
		});
		return new Proxy(mainWindow, {
			get(target, property, receiver) {
				return property === 'navigator' ? navigator : Reflect.get(target, property, receiver);
			}
		});
	}

	test('encodes signed little-endian PCM16', () => {
		const encoded = encodeRawPcm16Base64(new Float32Array([-1, 0, 1]), mainWindow);
		const binary = mainWindow.atob(encoded);

		assert.deepStrictEqual([...binary].map(character => character.charCodeAt(0)), [0, 128, 0, 0, 255, 127]);
	});

	test('allows only one audio owner', () => {
		const service = new AudioCaptureLeaseService();
		const first = store.add(service.acquire('dictation')!);

		assert.deepStrictEqual({
			first: !!first,
			competing: service.acquire('voice-mode'),
		}, {
			first: true,
			competing: undefined,
		});

		first.dispose();
		store.add(service.acquire('voice-mode')!);
	});

	test('does not request the fallback microphone after cancellation', async () => {
		const storageService = store.add(new TestStorageService());
		storageService.store(AgentsVoiceStorageKeys.MicrophoneDevice, 'missing-device', StorageScope.APPLICATION, StorageTarget.MACHINE);
		const capture = store.add(new DictationAudioCapture(storageService, new NullLogService()));
		const mediaRequest = new DeferredPromise<MediaStream>();
		let requestCount = 0;
		const window = createWindow(() => {
			requestCount++;
			return mediaRequest.p;
		});

		const acquiring = capture.acquire(window);
		capture.cancel();
		mediaRequest.error(new mainWindow.DOMException('Missing microphone', 'NotFoundError'));

		await assert.rejects(acquiring, /cancelled/);
		assert.strictEqual(requestCount, 1);
	});

	test('Voice cancellation stops a microphone stream that resolves late', async () => {
		const storageService = store.add(new TestStorageService());
		const capture = store.add(new MicCaptureService(storageService, new TestNotificationService(), new NullLogService()));
		const mediaRequest = new DeferredPromise<MediaStream>();
		let stopCount = 0;
		let pttStartCount = 0;
		const track = { stop: () => stopCount++ } as Partial<MediaStreamTrack> as MediaStreamTrack;
		const stream = { getTracks: () => [track] } as Partial<MediaStream> as MediaStream;
		store.add(capture.onPttStart(() => pttStartCount++));
		capture.prepare(createWindow(() => mediaRequest.p));

		const acquiring = capture.pttDown('voice-turn');
		capture.stopCapture();
		mediaRequest.complete(stream);

		await assert.rejects(acquiring, isCancellationError);
		assert.deepStrictEqual({
			isCapturing: capture.isCapturing,
			pttStartCount,
			stopCount,
		}, {
			isCapturing: false,
			pttStartCount: 0,
			stopCount: 1,
		});
	});

	test('Voice cancellation does not request a fallback microphone', async () => {
		const storageService = store.add(new TestStorageService());
		storageService.store(AgentsVoiceStorageKeys.MicrophoneDevice, 'missing-device', StorageScope.APPLICATION, StorageTarget.MACHINE);
		const capture = store.add(new MicCaptureService(storageService, new TestNotificationService(), new NullLogService()));
		const mediaRequest = new DeferredPromise<MediaStream>();
		let requestCount = 0;
		capture.prepare(createWindow(() => {
			requestCount++;
			return mediaRequest.p;
		}));

		const acquiring = capture.pttDown('voice-turn');
		capture.stopCapture();
		mediaRequest.error(new mainWindow.DOMException('Missing microphone', 'NotFoundError'));

		await assert.rejects(acquiring, isCancellationError);
		assert.strictEqual(requestCount, 1);
	});
});
