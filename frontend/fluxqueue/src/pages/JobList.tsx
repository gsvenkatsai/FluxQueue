// src/pages/JobList.tsx
import axios from "axios";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Job {
  id: string;
  job_type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  retry_count: number;
  error_msg: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
  RUNNING: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  COMPLETED: "bg-green-500/20 text-green-400 border border-green-500/30",
  FAILED: "bg-red-500/20 text-red-400 border border-red-500/30",
  DEAD: "bg-gray-500/20 text-gray-400 border border-gray-500/30",
};

const JobList = () => {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [job, setJob] = useState({ job_type: "email_send", payload: { to: "" } });

  const handleSubmit = () => {
    const payload = { ...job, idempotency_key: crypto.randomUUID() };
    axios.post<Job>("http://127.0.0.1:8000/api/jobs/", payload).then((res) => {
      setJobs([res.data, ...jobs]);
      setShowForm(false);
    });
  };

  useEffect(() => {
    axios.get<Job[]>("http://127.0.0.1:8000/api/jobs/").then((res) => setJobs(res.data));
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">FluxQueue</h1>
            <p className="text-gray-400 text-sm mt-1">Job Management</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => navigate("/dashboard")}
              className="px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 text-sm transition"
            >
              Dashboard
            </button>
            <button
              onClick={() => setShowForm(!showForm)}
              className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-gray-900 font-semibold text-sm transition"
            >
              {showForm ? "Cancel" : "+ New Job"}
            </button>
          </div>
        </div>

        {/* Submit Form */}
        {showForm && (
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-5 mb-6 flex gap-3 flex-wrap">
            <select
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1 min-w-[160px]"
              onChange={(e) => setJob({ ...job, job_type: e.target.value })}
            >
              <option value="email_send">Email Send</option>
              <option value="pdf_generate">PDF Generate</option>
              <option value="image_resize">Image Resize</option>
              <option value="data_export">Data Export</option>
            </select>
            <input
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1 min-w-[200px]"
              placeholder="Payload (email, file, etc.)"
              onChange={(e) => setJob({ ...job, payload: { ...job.payload, to: e.target.value } })}
            />
            <button
              onClick={handleSubmit}
              className="px-5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-gray-900 font-semibold text-sm transition"
            >
              Submit
            </button>
          </div>
        )}

        {/* Table */}
        <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400 text-xs uppercase tracking-wider">
                <th className="text-left px-5 py-3 font-semibold">Job Type</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
                <th className="text-left px-5 py-3 font-semibold">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr
                  key={j.id}
                  onClick={() => navigate(`/jobs/${j.id}`)}
                  className="border-b border-gray-700/50 hover:bg-gray-700/50 cursor-pointer transition"
                >
                  <td className="px-5 py-3 font-mono text-gray-300">{j.job_type}</td>
                  <td className="px-5 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[j.status] ?? "bg-gray-700 text-gray-300"}`}>
                      {j.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-gray-400">{new Date(j.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default JobList;
