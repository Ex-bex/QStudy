// Small Windows-only detached process launcher. No shell, services or scheduled tasks.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace QStudy.Local {
    public static class DetachedProcess {
        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo {
            public int Size; public string Reserved; public string Desktop; public string Title;
            public int X; public int Y; public int XSize; public int YSize; public int XChars; public int YChars;
            public int Fill; public int Flags; public short ShowWindow; public short ReservedSize;
            public IntPtr ReservedPtr; public IntPtr Input; public IntPtr Output; public IntPtr Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation { public IntPtr Process; public IntPtr Thread; public int ProcessId; public int ThreadId; }
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
            ref StartupInfo startup, out ProcessInformation result);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes,
            uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll")]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        private static readonly IntPtr Invalid = new IntPtr(-1);

        // Query identity and terminate using the same handle. PID recycling after
        // OpenProcess cannot redirect termination to another application.
        public static bool Stop(int processId, long expectedCreation, string expectedExecutable) {
            IntPtr process = OpenProcess(0x100000 | 0x1000 | 0x1, false, processId);
            if (process == IntPtr.Zero) {
                int code = Marshal.GetLastWin32Error();
                if (code == 87) return false; // The recorded process already exited.
                throw new Win32Exception(code, "Cannot open recorded QStudy process for stopping");
            }
            try {
                long created, exited, kernel, user;
                if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
                // Win32_Process exposes microseconds; FILETIME exposes 100ns.
                if (created / 10 != expectedCreation / 10) return false;
                StringBuilder path = new StringBuilder(32768); int length = path.Capacity;
                if (!QueryFullProcessImageName(process, 0, path, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!String.Equals(path.ToString(), expectedExecutable, StringComparison.OrdinalIgnoreCase)) return false;
                if (WaitForSingleObject(process, 0) == 0) return false;
                if (!TerminateProcess(process, 0)) {
                    int code = Marshal.GetLastWin32Error();
                    if (WaitForSingleObject(process, 0) != 0) throw new Win32Exception(code, "Cannot stop recorded QStudy process");
                }
                WaitForSingleObject(process, 3000);
                return true;
            } finally { CloseHandle(process); }
        }

        // Windows CRT quoting, including embedded quotes and trailing backslashes.
        public static string Quote(string argument) {
            if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '"' }) < 0) return argument;
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in argument) {
                if (character == '\\') { slashes++; continue; }
                if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(character);
            }
            result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
        }

        public static int Start(string executable, string[] arguments, string directory, string stdout, string stderr) {
            SecurityAttributes attributes = new SecurityAttributes();
            attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Inherit = true;
            IntPtr output = Invalid; IntPtr error = Invalid; IntPtr input = Invalid;
            ProcessInformation created = new ProcessInformation();
            try {
                output = CreateFile(stdout, 0x40000000, 3, ref attributes, 2, 0x80, IntPtr.Zero);
                error = CreateFile(stderr, 0x40000000, 3, ref attributes, 2, 0x80, IntPtr.Zero);
                input = CreateFile("NUL", 0x80000000, 3, ref attributes, 3, 0x80, IntPtr.Zero);
                if (output == Invalid || error == Invalid || input == Invalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open local log files");
                StartupInfo info = new StartupInfo(); info.Size = Marshal.SizeOf(typeof(StartupInfo));
                info.Flags = 0x00000101; info.ShowWindow = 0; info.Input = input; info.Output = output; info.Error = error;
                bool inJob;
                if (!IsProcessInJob(Process.GetCurrentProcess().Handle, IntPtr.Zero, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint flags = 0x08000000 | 0x00000200 | 0x00000400; // hidden + independent process group + Unicode environment
                if (inJob) flags |= 0x01000000; // break away from an owning application job
                StringBuilder command = new StringBuilder(Quote(executable));
                foreach (string argument in arguments) command.Append(" ").Append(Quote(argument));
                if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, directory, ref info, out created)) {
                    int code = Marshal.GetLastWin32Error();
                    if (inJob && code == 5) throw new Win32Exception(code, "The parent application forbids detached processes. Run Start-QStudy.cmd directly from File Explorer");
                    throw new Win32Exception(code, "Cannot launch local QStudy process");
                }
                return created.ProcessId;
            } finally {
                if (created.Thread != IntPtr.Zero) CloseHandle(created.Thread);
                if (created.Process != IntPtr.Zero) CloseHandle(created.Process);
                if (output != Invalid) CloseHandle(output);
                if (error != Invalid) CloseHandle(error);
                if (input != Invalid) CloseHandle(input);
            }
        }
    }
}
