# Read-only Windows Core Audio monitor. Never prints endpoint IDs or audio data.
# A closed parent stdin ends the monitor even if Electron exits unexpectedly.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out IntPtr collection);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr instance);
    [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

public static class VinxaDefaultOutput
{
    static volatile bool stopping;

    static string[] Snapshot(IMMDeviceEnumerator enumerator)
    {
        string[] endpoints = new string[3];
        for (int role = 0; role < endpoints.Length; role++)
        {
            IMMDevice endpoint = null;
            try
            {
                int result = enumerator.GetDefaultAudioEndpoint(0, role, out endpoint);
                // E_NOTFOUND also represents removal of the last output device.
                if (result == unchecked((int)0x80070490)) { endpoints[role] = ""; continue; }
                Marshal.ThrowExceptionForHR(result);
                string id;
                Marshal.ThrowExceptionForHR(endpoint.GetId(out id));
                endpoints[role] = id;
            }
            finally { if (endpoint != null) Marshal.ReleaseComObject(endpoint); }
        }
        return endpoints;
    }

    static void Report(string status)
    {
        Console.Out.WriteLine(status);
        Console.Out.Flush();
    }

    public static int Run()
    {
        IMMDeviceEnumerator enumerator = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            string[] original = Snapshot(enumerator);
            Thread parent = new Thread(() => { Console.In.ReadLine(); stopping = true; });
            parent.IsBackground = true;
            parent.Start();
            Report("ready");
            int ticks = 0;
            while (!stopping)
            {
                Thread.Sleep(250);
                if (stopping) break;
                string[] current = Snapshot(enumerator);
                for (int role = 0; role < original.Length; role++)
                {
                    if (current[role] != original[role]) { Report("changed"); return 0; }
                }
                if (++ticks % 4 == 0) Report("heartbeat");
            }
            return 0;
        }
        catch { Report("error"); return 1; }
        finally { if (enumerator != null) Marshal.ReleaseComObject(enumerator); }
    }
}
'@
    exit ([VinxaDefaultOutput]::Run())
}
catch {
    [Console]::Out.WriteLine('error')
    exit 1
}
