// Owns a data-directory lock and exactly one child. The parent controls this
// helper through stdin; EOF also tears down the child when Bridge is killed.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <chrono>
#include <thread>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <iphlpapi.h>
static bool ownsListener(DWORD pid, int port) {
    DWORD size = 0;
    GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (!size) return false;
    std::vector<unsigned char> buffer(size);
    auto table = reinterpret_cast<MIB_TCPTABLE_OWNER_PID *>(buffer.data());
    if (GetExtendedTcpTable(table, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) != NO_ERROR) return false;
    for (DWORD i=0; i<table->dwNumEntries; ++i) {
        const auto &row = table->table[i];
        if (row.dwOwningPid == pid && ntohs(static_cast<u_short>(row.dwLocalPort)) == port &&
            ntohl(row.dwLocalAddr) == INADDR_LOOPBACK) return true;
    }
    return false;
}
static std::wstring quote(const std::wstring &s) {
    std::wstring out = L"\""; unsigned slashes = 0;
    for (wchar_t c : s) {
        if (c == L'\\') { ++slashes; continue; }
        out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        slashes = 0; out += c;
    }
    out.append(slashes * 2, L'\\'); return out + L"\"";
}
static BOOL WINAPI consoleHandler(DWORD) { return TRUE; }
int wmain(int argc, wchar_t **argv) {
    if (argc < 2) return 2;
    int commandIndex = 2, port = 0;
    if (argc > 4 && std::wstring(argv[2]) == L"--listen-port") { port = _wtoi(argv[3]); commandIndex = 4; }
    bool listening = false;
    SetConsoleCtrlHandler(consoleHandler, TRUE);
    // The child inherits this mode: a missing DLL (the Vulkan loader) ends it
    // with STATUS_DLL_NOT_FOUND instead of a dialog that blocks until timeout.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    HANDLE lock = CreateFileW(argv[1], GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (lock == INVALID_HANDLE_VALUE) { std::puts("{\"event\":\"lock-error\"}"); return 3; }
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 4;
    HANDLE child = nullptr; bool started = false, done = false;
    std::puts("{\"event\":\"locked\"}"); std::fflush(stdout);
    while (!done) {
        DWORD available = 0;
        if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) break;
        if (available) {
            char cmd; DWORD n;
            if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &cmd, 1, &n, nullptr) || !n) break;
            if (cmd == 'Q') done = true;
            if (cmd == 'T') TerminateJobObject(job, 0);
            if (cmd == 'S' && !started && argc > commandIndex) {
                started = true;
                std::wstring command;
                for (int i=commandIndex; i<argc; ++i) { if (i>commandIndex) command += L" "; command += quote(argv[i]); }
                STARTUPINFOW si{}; si.cb = sizeof(si); si.dwFlags = STARTF_USESTDHANDLES;
                SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
                HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
                si.hStdInput = input;
                si.hStdOutput = si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
                PROCESS_INFORMATION pi{};
                BOOL ok = CreateProcessW(argv[commandIndex], command.data(), nullptr, nullptr, TRUE,
                    CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
                CloseHandle(input);
                if (ok && AssignProcessToJobObject(job, pi.hProcess)) {
                    child = pi.hProcess;
                    ResumeThread(pi.hThread); CloseHandle(pi.hThread);
                    std::printf("{\"event\":\"spawned\",\"pid\":%lu}\n", pi.dwProcessId);
                } else {
                    if (ok) { TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }
                    std::puts("{\"event\":\"spawn-error\"}");
                }
                std::fflush(stdout);
            }
        }
        if (child && WaitForSingleObject(child, 0) == WAIT_OBJECT_0) {
            DWORD code; GetExitCodeProcess(child, &code); CloseHandle(child); child=nullptr;
            std::printf("{\"event\":\"exited\",\"code\":%lu}\n", code); std::fflush(stdout);
        }
        if (child && port && !listening && ownsListener(GetProcessId(child), port)) {
            listening = true; std::puts("{\"event\":\"listening\"}"); std::fflush(stdout);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    TerminateJobObject(job, 0);
    if (child) { WaitForSingleObject(child, 5000); CloseHandle(child); }
    CloseHandle(job); CloseHandle(lock); return 0;
}
#else
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <sys/select.h>
#include <cerrno>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <arpa/inet.h>
static bool ownsListener(pid_t pid, int port) {
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nullptr, 0);
    if (bytes <= 0) return false;
    std::vector<proc_fdinfo> fds(bytes / sizeof(proc_fdinfo) + 16);
    bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds.data(), int(fds.size() * sizeof(proc_fdinfo)));
    for (int i=0; i<bytes / int(sizeof(proc_fdinfo)); ++i) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        socket_fdinfo info{};
        if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info)) != sizeof(info)) continue;
        const auto &tcp = info.psi.soi_proto.pri_tcp;
        if (info.psi.soi_kind == SOCKINFO_TCP && info.psi.soi_family == AF_INET &&
            tcp.tcpsi_state == TSI_S_LISTEN && ntohs(tcp.tcpsi_ini.insi_lport) == port &&
            ntohl(tcp.tcpsi_ini.insi_laddr.ina_46.i46a_addr4.s_addr) == INADDR_LOOPBACK) return true;
    }
    return false;
}
static volatile sig_atomic_t stopping = 0;
static void stop(int) { stopping = 1; }
static void terminateChild(pid_t &child) {
    if (child <= 0) return;
    kill(-child, SIGTERM); kill(child, SIGTERM);
    bool reaped = false;
    for (int i=0;i<100;i++) {
        if (waitpid(child, nullptr, WNOHANG) == child) { reaped=true; break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!reaped) { kill(-child, SIGKILL); kill(child, SIGKILL); waitpid(child, nullptr, 0); }
    child = -1;
}
int main(int argc, char **argv) {
    if (argc < 2) return 2;
    int commandIndex = 2, port = 0;
    if (argc > 4 && std::strcmp(argv[2], "--listen-port") == 0) { port = std::atoi(argv[3]); commandIndex = 4; }
    bool listening = false;
    int lock = open(argv[1], O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) { std::puts("{\"event\":\"lock-error\"}"); return 3; }
    signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
    pid_t child = -1; bool started = false;
    std::puts("{\"event\":\"locked\"}"); std::fflush(stdout);
    while (!stopping) {
        fd_set fds; FD_ZERO(&fds); FD_SET(STDIN_FILENO, &fds);
        timeval timeout{0, 25000};
        int ready = select(STDIN_FILENO+1, &fds, nullptr, nullptr, &timeout);
        if (ready < 0 && errno != EINTR) break;
        if (ready > 0) {
            char cmd; if (read(STDIN_FILENO, &cmd, 1) != 1) break;
            if (cmd == 'Q') break;
            if (cmd == 'T') terminateChild(child);
            if (cmd == 'S' && !started && argc > commandIndex) {
                started = true; child = fork();
                if (child == 0) {
                    setsid(); signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
                    int input = open("/dev/null", O_RDONLY); dup2(input, STDIN_FILENO); close(input);
                    dup2(STDERR_FILENO, STDOUT_FILENO);
                    execv(argv[commandIndex], argv+commandIndex); _exit(127);
                }
                if (child < 0) std::puts("{\"event\":\"spawn-error\"}");
                else std::printf("{\"event\":\"spawned\",\"pid\":%d}\n", int(child));
                std::fflush(stdout);
            }
        }
        if (child > 0 && port && !listening && ownsListener(child, port)) {
            listening = true; std::puts("{\"event\":\"listening\"}"); std::fflush(stdout);
        }
        int status;
        if (child > 0 && waitpid(child, &status, WNOHANG) == child) {
            child = -1;
            std::printf("{\"event\":\"exited\",\"code\":%d}\n", WIFEXITED(status) ? WEXITSTATUS(status) : 128+WTERMSIG(status));
            std::fflush(stdout);
        }
    }
    terminateChild(child);
    close(lock); return 0;
}
#endif
