const { spawnSync } = require('node:child_process');

const target = process.argv[2];
if (!target) {
  console.error('用法: node who-locks.cjs <路径>');
  process.exit(1);
}

const script = `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RmProbe {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    const int RmRebootReasonNone = 0;
    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;

    enum RM_APP_TYPE {
        RmUnknownApp = 0, RmMainWindow = 1, RmOtherWindow = 2,
        RmService = 3, RmExplorer = 4, RmConsole = 5, RmCritical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
        public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle,
        uint nFiles, string[] rgsFilenames,
        uint nApplications, RM_UNIQUE_PROCESS[] rgApplications,
        uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded,
        ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static List<string> Who(string path) {
        uint handle;
        string key = Guid.NewGuid().ToString();
        var result = new List<string>();
        if (RmStartSession(out handle, 0, key) != 0) throw new Exception("RmStartSession failed");
        try {
            string[] resources = new string[] { path };
            if (RmRegisterResources(handle, 1, resources, 0, null, 0, null) != 0)
                throw new Exception("RmRegisterResources failed");

            uint pnProcInfoNeeded = 0, pnProcInfo = 0, lpdwRebootReasons = RmRebootReasonNone;
            int res = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, null, ref lpdwRebootReasons);
            if (res == 234) {
                var infos = new RM_PROCESS_INFO[pnProcInfoNeeded];
                pnProcInfo = (uint)infos.Length;
                if (RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, infos, ref lpdwRebootReasons) != 0)
                    throw new Exception("RmGetList failed");
                for (int i = 0; i < pnProcInfo; i++) {
                    result.Add(infos[i].Process.dwProcessId + "|" + infos[i].strAppName + "|" + infos[i].ApplicationType);
                }
            }
        } finally {
            RmEndSession(handle);
        }
        return result;
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$hits = [RmProbe]::Who('${target.replace(/'/g, "''")}')
if ($hits.Count -eq 0) { '没有进程占用' } else { $hits }
`;

const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});

if (out.stdout) process.stdout.write(out.stdout);
if (out.stderr && out.stderr.trim()) process.stderr.write(out.stderr);
