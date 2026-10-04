/** A small native helper assigns a suspended child before it can create descendants. */
export const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

class ContainedProcess {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IO Io; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags; public ushort showWindow,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits limits,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,ref Accounting accounting,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string value) {
    StringBuilder result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') result.Append('\\',slashes*2+1); else result.Append('\\',slashes);
      result.Append(c); slashes=0;
    }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  static bool Drain(IntPtr job) {
    if(!TerminateJobObject(job,130)) return false;
    for(int i=0;i<200;i++) {
      Accounting data=new Accounting();
      if(!QueryInformationJobObject(job,1,ref data,(uint)Marshal.SizeOf(data),IntPtr.Zero)) return false;
      if(data.ActiveProcesses==0) return true;
      Thread.Sleep(25);
    }
    return false;
  }
  static int Main(string[] args) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero; ProcessInfo info=new ProcessInfo();
    try {
      if(args[0]=="cleanup") {
        job=OpenJobObject(0x0004|0x0008,false,args[1]);
        if(job==IntPtr.Zero) return Marshal.GetLastWin32Error()==2 ? 0 : 125;
        return Drain(job) ? 0 : 125;
      }
      parent=OpenProcess(0x00100000,false,uint.Parse(args[0]));
      if(parent==IntPtr.Zero) throw new Exception("Owner is unavailable");
      job=CreateJobObject(IntPtr.Zero,args[1]);
      if(job==IntPtr.Zero) throw new Exception("Cannot create process scope");
      ExtendedLimits limits=new ExtendedLimits();
      limits.Basic.LimitFlags=0x00002000|0x00000008;
      limits.Basic.ActiveProcessLimit=uint.Parse(args[2]);
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Exception("Cannot set process limit");
      Startup startup=new Startup(); startup.cb=(uint)Marshal.SizeOf(startup); startup.flags=0x00000100;
      startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
      SetHandleInformation(startup.input,1,1); SetHandleInformation(startup.output,1,1); SetHandleInformation(startup.error,1,1);
      StringBuilder command=new StringBuilder();
      for(int i=4;i<args.Length;i++) { if(i>4) command.Append(' '); command.Append(Quote(args[i])); }
      if(!CreateProcess(args[4],command,IntPtr.Zero,IntPtr.Zero,true,0x00000004|0x08000000,IntPtr.Zero,args[3],ref startup,out info)) throw new Exception("Cannot start target ("+Marshal.GetLastWin32Error()+")");
      if(!AssignProcessToJobObject(job,info.process)) throw new Exception("Cannot contain target");
      if(ResumeThread(info.thread)==0xffffffff) throw new Exception("Cannot resume target");
      uint finished=WaitForMultipleObjects(2,new IntPtr[]{parent,info.process},false,0xffffffff);
      uint code=130;
      if(finished==1) GetExitCodeProcess(info.process,out code);
      if(!Drain(job)) throw new Exception("Process cleanup failed");
      return (int)code;
    } catch(Exception error) {
      Console.Error.WriteLine("Containment: "+error.Message);
      if(info.process!=IntPtr.Zero) TerminateProcess(info.process,125);
      if(job!=IntPtr.Zero) Drain(job);
      return 125;
    } finally {
      if(info.thread!=IntPtr.Zero) CloseHandle(info.thread);
      if(info.process!=IntPtr.Zero) CloseHandle(info.process);
      if(parent!=IntPtr.Zero) CloseHandle(parent);
      if(job!=IntPtr.Zero) CloseHandle(job);
    }
  }
}
`;
