// Media+ companion: native messaging host that runs yt-dlp for the extension.
// Built by install.ps1 with the C# compiler that ships with Windows (.NET Framework 4).
//
// Messages (JSON, 4-byte length prefix, from Chrome):
//   { cmd: "ping" }
//   { cmd: "download", id, url, format: "mp4"|"mp3", quality: "best"|"compat", maxHeight, start, end, cookies }
//   { cmd: "cancel", id }      { cmd: "cleanup", id }
// Finished files are served once to Chrome's download manager from http://127.0.0.1:<port>/<token>/<id>,
// so the user gets Chrome's own "Save as" dialog and download list.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class Job
{
    public string Id;
    public string Dir;
    public string File;
    public Process Proc;
    public bool Cancelled;
}

static class Host
{
    const string Version = "1.1.0";
    static readonly object OutLock = new object();
    static readonly object JobsLock = new object();
    static readonly Dictionary<string, Job> Jobs = new Dictionary<string, Job>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly string Token = Guid.NewGuid().ToString("N");
    static Stream stdout;
    static string root;
    static string ytdlp = "yt-dlp";
    static string ffmpeg = "";
    static string ytdlpVersion = null;
    static int port;

    static void Main()
    {
        stdout = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();
        root = Path.Combine(Path.GetTempPath(), "MediaPlus", Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(root);
        LoadConfig();
        StartServer();

        while (true)
        {
            Dictionary<string, object> msg = Read(stdin);
            if (msg == null) break;
            try { Handle(msg); }
            catch (Exception e) { Send(Obj("type", "error", "id", Str(msg, "id"), "error", e.Message)); }
        }

        lock (JobsLock) { foreach (Job j in Jobs.Values) Kill(j); }
        try { Directory.Delete(root, true); } catch { }
    }

    // ---------- Native messaging ----------

    static Dictionary<string, object> Read(Stream input)
    {
        byte[] head = ReadExact(input, 4);
        if (head == null) return null;
        int len = BitConverter.ToInt32(head, 0);
        if (len <= 0 || len > 64 * 1024 * 1024) return null;
        byte[] body = ReadExact(input, len);
        if (body == null) return null;
        return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
    }

    static byte[] ReadExact(Stream input, int count)
    {
        byte[] buf = new byte[count];
        int read = 0;
        while (read < count)
        {
            int n = input.Read(buf, read, count - read);
            if (n <= 0) return null;
            read += n;
        }
        return buf;
    }

    static void Send(Dictionary<string, object> msg)
    {
        byte[] body = Encoding.UTF8.GetBytes(Json.Serialize(msg));
        lock (OutLock)
        {
            stdout.Write(BitConverter.GetBytes(body.Length), 0, 4);
            stdout.Write(body, 0, body.Length);
            stdout.Flush();
        }
    }

    static Dictionary<string, object> Obj(params object[] kv)
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }

    static string Str(Dictionary<string, object> m, string key)
    {
        object v;
        return m != null && m.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : null;
    }

    static double Num(Dictionary<string, object> m, string key, double fallback)
    {
        string s = Str(m, key);
        double d;
        return s != null && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d) ? d : fallback;
    }

    // ---------- Commands ----------

    static void LoadConfig()
    {
        string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");
        if (!System.IO.File.Exists(file)) return;
        Dictionary<string, object> cfg = Json.Deserialize<Dictionary<string, object>>(System.IO.File.ReadAllText(file));
        ytdlp = Str(cfg, "ytdlp") ?? ytdlp;
        ffmpeg = Str(cfg, "ffmpeg") ?? "";
        ytdlpVersion = Str(cfg, "ytdlpVersion");
    }

    static void Handle(Dictionary<string, object> msg)
    {
        string cmd = Str(msg, "cmd");
        string id = Str(msg, "id");
        if (cmd == "ping")
        {
            // Answer at once: a cold yt-dlp.exe can take seconds to start, too slow for a status check.
            Send(Obj("type", "pong", "id", id, "version", Version, "ytdlp", ytdlpVersion,
                "ytdlpFound", System.IO.File.Exists(ytdlp), "ffmpeg", ffmpeg != "" && System.IO.File.Exists(ffmpeg)));
        }
        else if (cmd == "download")
        {
            StartDownload(msg);
        }
        else if (cmd == "cancel")
        {
            Job job = Find(id);
            if (job != null) { job.Cancelled = true; Kill(job); }
        }
        else if (cmd == "cleanup")
        {
            Job job = Find(id);
            if (job == null) return;
            lock (JobsLock) Jobs.Remove(id);
            Kill(job);
            try { Directory.Delete(job.Dir, true); } catch { }
        }
    }

    static Job Find(string id)
    {
        lock (JobsLock)
        {
            Job j;
            return id != null && Jobs.TryGetValue(id, out j) ? j : null;
        }
    }

    static void StartDownload(Dictionary<string, object> msg)
    {
        string id = Str(msg, "id");
        string url = Str(msg, "url");
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(url) || !(url.StartsWith("http://") || url.StartsWith("https://")))
            throw new Exception("Invalid request");

        Job job = new Job();
        job.Id = id;
        job.Dir = Path.Combine(root, id);
        Directory.CreateDirectory(job.Dir);
        lock (JobsLock) Jobs[id] = job;

        List<string> args = new List<string>();
        args.AddRange(new string[] {
            "--no-playlist", "--newline", "--progress", "--no-colors", "--encoding", "utf-8",
            "--no-simulate", "--print", "after_move:MPFILE:%(filepath)s",
            "--progress-template", "download:MPPROG:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
            "--progress-template", "postprocess:MPPOST:%(progress.postprocessor)s",
            "-o", Path.Combine(job.Dir, "%(title).120B.%(ext)s")
        });
        if (ffmpeg != "") { args.Add("--ffmpeg-location"); args.Add(ffmpeg); }

        string format = Str(msg, "format");
        if (format == "mp3")
        {
            args.AddRange(new string[] { "-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0" });
        }
        else
        {
            // The extension picks the format (-f) and sort order (-S): they are only ever passed
            // as the values of those two options, so they can't add options of their own.
            string spec = SafeSpec(Str(msg, "formatSpec")) ?? "bv*+ba/b";
            string sort = SafeSpec(Str(msg, "sortSpec")) ?? "res,ext:mp4:m4a";
            args.AddRange(new string[] { "-f", spec, "-S", sort, "--merge-output-format", "mp4", "--remux-video", "mp4" });
        }

        double start = Num(msg, "start", -1);
        double end = Num(msg, "end", -1);
        if (start >= 0 && end > start)
        {
            args.Add("--download-sections");
            args.Add("*" + start.ToString("0.###", CultureInfo.InvariantCulture) + "-" + end.ToString("0.###", CultureInfo.InvariantCulture));
            args.Add("--force-keyframes-at-cuts");
        }

        string cookies = Str(msg, "cookies");
        if (!string.IsNullOrEmpty(cookies))
        {
            string cookieFile = Path.Combine(job.Dir, "cookies.txt");
            System.IO.File.WriteAllText(cookieFile, cookies, new UTF8Encoding(false));
            args.Add("--cookies");
            args.Add(cookieFile);
        }

        args.Add("--");
        args.Add(url);

        ProcessStartInfo psi = new ProcessStartInfo(ytdlp, JoinArgs(args));
        psi.UseShellExecute = false;
        // Own stdin: otherwise yt-dlp/ffmpeg would read Chrome's message pipe.
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        psi.EnvironmentVariables["PYTHONUTF8"] = "1";

        Thread worker = new Thread(delegate () { Run(job, psi); });
        worker.IsBackground = true;
        worker.Start();
    }

    static void Run(Job job, ProcessStartInfo psi)
    {
        StringBuilder errors = new StringBuilder();
        try
        {
            job.Proc = Process.Start(psi);
            job.Proc.StandardInput.Close();
            job.Proc.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                lock (errors) { if (errors.Length < 8000) errors.AppendLine(e.Data); }
            };
            job.Proc.BeginErrorReadLine();

            string line;
            DateTime lastProgress = DateTime.MinValue;
            while ((line = job.Proc.StandardOutput.ReadLine()) != null)
            {
                if (line.StartsWith("MPPROG:"))
                {
                    if ((DateTime.UtcNow - lastProgress).TotalMilliseconds < 400) continue;
                    lastProgress = DateTime.UtcNow;
                    string[] p = line.Substring(7).Split('|');
                    Send(Obj("type", "progress", "id", job.Id,
                        "percent", p.Length > 0 ? p[0].Trim() : "", "speed", p.Length > 1 ? p[1].Trim() : "", "eta", p.Length > 2 ? p[2].Trim() : ""));
                }
                else if (line.StartsWith("MPPOST:"))
                {
                    Send(Obj("type", "progress", "id", job.Id, "stage", line.Substring(7).Trim()));
                }
                else if (line.StartsWith("MPFILE:"))
                {
                    job.File = line.Substring(7).Trim();
                }
            }
            job.Proc.WaitForExit();

            if (job.Cancelled) return;
            if (job.Proc.ExitCode == 0 && job.File != null && System.IO.File.Exists(job.File))
            {
                FileInfo info = new FileInfo(job.File);
                Send(Obj("type", "done", "id", job.Id, "name", info.Name, "size", info.Length,
                    "url", "http://127.0.0.1:" + port + "/" + Token + "/" + job.Id));
            }
            else
            {
                Send(Obj("type", "error", "id", job.Id, "error", LastError(errors.ToString()), "code", job.Proc.ExitCode, "file", job.File));
            }
        }
        catch (Exception e)
        {
            if (!job.Cancelled) Send(Obj("type", "error", "id", job.Id, "error", e.Message));
        }
    }

    static string SafeSpec(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 400 || value.StartsWith("-")) return null;
        foreach (char c in value) if (char.IsControl(c) || c == '"') return null;
        return value;
    }

    static string LastError(string stderr)
    {
        string[] lines = stderr.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        for (int i = lines.Length - 1; i >= 0; i--)
            if (lines[i].StartsWith("ERROR:")) return lines[i].Substring(6).Trim();
        return lines.Length > 0 ? lines[lines.Length - 1] : "yt-dlp failed";
    }

    static void Kill(Job job)
    {
        try
        {
            if (job.Proc != null && !job.Proc.HasExited)
            {
                // yt-dlp may have started ffmpeg: end the whole tree.
                Process.Start(new ProcessStartInfo("taskkill", "/PID " + job.Proc.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false }).WaitForExit(5000);
            }
        }
        catch { }
    }

    // Windows command-line quoting (CommandLineToArgvW rules).
    static string JoinArgs(List<string> args)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string arg in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) { sb.Append(arg); continue; }
            sb.Append('"');
            int slashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
                else { sb.Append('\\', slashes); sb.Append(c); }
                slashes = 0;
            }
            sb.Append('\\', slashes * 2);
            sb.Append('"');
        }
        return sb.ToString();
    }

    // ---------- Local file server (127.0.0.1 only, random token) ----------

    static void StartServer()
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Thread t = new Thread(delegate ()
        {
            while (true)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); } catch { return; }
                Thread c = new Thread(delegate () { Serve(client); });
                c.IsBackground = true;
                c.Start();
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    static void Serve(TcpClient client)
    {
        using (client)
        using (NetworkStream net = client.GetStream())
        {
            try
            {
                StreamReader reader = new StreamReader(net, Encoding.ASCII);
                string request = reader.ReadLine() ?? "";
                string header;
                while (!string.IsNullOrEmpty(header = reader.ReadLine())) { }

                string[] parts = request.Split(' ');
                string method = parts.Length > 0 ? parts[0] : "";
                string[] path = parts.Length > 1 ? parts[1].Trim('/').Split('/') : new string[0];
                Job job = path.Length == 2 && path[0] == Token ? Find(path[1]) : null;
                if ((method != "GET" && method != "HEAD") || job == null || job.File == null || !System.IO.File.Exists(job.File))
                {
                    byte[] notFound = Encoding.ASCII.GetBytes("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    net.Write(notFound, 0, notFound.Length);
                    return;
                }

                FileInfo info = new FileInfo(job.File);
                string name = Uri.EscapeDataString(info.Name);
                string head = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: application/octet-stream\r\n" +
                    "Content-Length: " + info.Length + "\r\n" +
                    "Content-Disposition: attachment; filename*=UTF-8''" + name + "\r\n" +
                    "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
                byte[] headBytes = Encoding.ASCII.GetBytes(head);
                net.Write(headBytes, 0, headBytes.Length);
                if (method == "GET")
                {
                    using (FileStream fs = System.IO.File.OpenRead(job.File)) fs.CopyTo(net, 1 << 16);
                }
            }
            catch { }
        }
    }
}
