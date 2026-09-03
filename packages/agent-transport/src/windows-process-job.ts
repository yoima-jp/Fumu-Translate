import * as koffi from 'koffi';

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export interface ProcessTreeGuard {
  close(): void;
}

function validHandle(handle: unknown): boolean {
  return handle !== null && handle !== undefined && handle !== 0 && handle !== 0n;
}

/**
 * Assigns a child to a Windows Job Object whose lifetime is owned by Fumu.
 * Closing the job kills the child and every descendant that did not explicitly
 * request a breakaway flag. This is process-lifetime containment, not a security
 * sandbox: a configured Codex/ACP executable remains trusted user software.
 */
export function createWindowsProcessTreeGuard(processId: number): ProcessTreeGuard | null {
  if (process.platform !== 'win32') {
    return null;
  }
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('The agent process did not expose a valid process identifier.');
  }

  const basicLimitType = koffi.struct({
    perProcessUserTimeLimit: 'int64',
    perJobUserTimeLimit: 'int64',
    limitFlags: 'uint32',
    minimumWorkingSetSize: 'uintptr_t',
    maximumWorkingSetSize: 'uintptr_t',
    activeProcessLimit: 'uint32',
    affinity: 'uintptr_t',
    priorityClass: 'uint32',
    schedulingClass: 'uint32',
  });
  const ioCountersType = koffi.struct({
    readOperationCount: 'uint64',
    writeOperationCount: 'uint64',
    otherOperationCount: 'uint64',
    readTransferCount: 'uint64',
    writeTransferCount: 'uint64',
    otherTransferCount: 'uint64',
  });
  const extendedLimitType = koffi.struct({
    basicLimitInformation: basicLimitType,
    ioInfo: ioCountersType,
    processMemoryLimit: 'uintptr_t',
    jobMemoryLimit: 'uintptr_t',
    peakProcessMemoryUsed: 'uintptr_t',
    peakJobMemoryUsed: 'uintptr_t',
  });

  const kernel32 = koffi.load('kernel32.dll');
  const createJobObject = kernel32.func('__stdcall', 'CreateJobObjectW', 'void *', [
    'void *',
    'str16',
  ]) as (securityAttributes: null, name: null) => unknown;
  const setInformationJobObject = kernel32.func('__stdcall', 'SetInformationJobObject', 'bool', [
    'void *',
    'int32',
    koffi.pointer(extendedLimitType),
    'uint32',
  ]) as (job: unknown, informationClass: number, information: unknown, size: number) => boolean;
  const openProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', [
    'uint32',
    'bool',
    'uint32',
  ]) as (access: number, inheritHandle: boolean, id: number) => unknown;
  const assignProcessToJobObject = kernel32.func('__stdcall', 'AssignProcessToJobObject', 'bool', [
    'void *',
    'void *',
  ]) as (job: unknown, processHandle: unknown) => boolean;
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *']) as (
    handle: unknown,
  ) => boolean;
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []) as () => number;

  const jobHandle = createJobObject(null, null);
  if (!validHandle(jobHandle)) {
    throw new Error(`Windows could not create an agent Job Object (${String(getLastError())}).`);
  }

  let closeJob = true;
  try {
    const information = {
      basicLimitInformation: {
        perProcessUserTimeLimit: 0n,
        perJobUserTimeLimit: 0n,
        limitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        minimumWorkingSetSize: 0,
        maximumWorkingSetSize: 0,
        activeProcessLimit: 0,
        affinity: 0,
        priorityClass: 0,
        schedulingClass: 0,
      },
      ioInfo: {
        readOperationCount: 0n,
        writeOperationCount: 0n,
        otherOperationCount: 0n,
        readTransferCount: 0n,
        writeTransferCount: 0n,
        otherTransferCount: 0n,
      },
      processMemoryLimit: 0,
      jobMemoryLimit: 0,
      peakProcessMemoryUsed: 0,
      peakJobMemoryUsed: 0,
    };
    if (
      !setInformationJobObject(
        jobHandle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        information,
        koffi.sizeof(extendedLimitType),
      )
    ) {
      throw new Error(
        `Windows could not configure the agent Job Object (${String(getLastError())}).`,
      );
    }

    const processHandle = openProcess(
      PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
      false,
      processId,
    );
    if (!validHandle(processHandle)) {
      throw new Error(`Windows could not open the agent process (${String(getLastError())}).`);
    }
    try {
      if (!assignProcessToJobObject(jobHandle, processHandle)) {
        throw new Error(
          `Windows could not contain the agent process tree (${String(getLastError())}).`,
        );
      }
    } finally {
      closeHandle(processHandle);
    }

    closeJob = false;
    let closed = false;
    return {
      close(): void {
        if (closed) {
          return;
        }
        closed = true;
        closeHandle(jobHandle);
        kernel32.unload();
      },
    };
  } finally {
    if (closeJob) {
      closeHandle(jobHandle);
      kernel32.unload();
    }
  }
}
