import axios from "axios";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Job {
  id: string;
  job_type: string;
  status: string;
  payload: Record<string, any>;
  result: Record<string, any> | null;
  retry_count: number;
  error_msg: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const statusBadge: Record<string, string> = {
  PENDING: "warning",
  RUNNING: "primary",
  COMPLETED: "success",
  FAILED: "danger",
};

const JobList = () => {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [job, setJob] = useState({
    job_type: "email_send",
    payload: { to: "" },
  });

  const handleSubmit = () => {
    axios.post<Job>("http://127.0.0.1:8000/api/jobs/", job).then((res) => {
      setJobs([res.data, ...jobs]);
      setShowForm(false);
    });
  };

  useEffect(() => {
    axios
      .get<Job[]>("http://127.0.0.1:8000/api/jobs/")
      .then((res) => setJobs(res.data));
  }, []);

  return (
    <div className="container mt-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">FluxQueue Jobs</h2>
        <button
          className="btn btn-primary"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? "Cancel" : "+ New Job"}
        </button>
      </div>

      {showForm && (
        <div className="card mb-4 p-3">
          <div className="row g-2">
            <div className="col-md-4">
              <select
                className="form-select"
                onChange={(e) => setJob({ ...job, job_type: e.target.value })}
              >
                <option value="email_send">Email Send</option>
                <option value="pdf_generate">PDF Generate</option>
                <option value="image_resize">Image Resize</option>
                <option value="data_export">Data Export</option>
              </select>
            </div>
            <div className="col-md-5">
              <input
                className="form-control"
                placeholder="to (email)"
                onChange={(e) =>
                  setJob({
                    ...job,
                    payload: { ...job.payload, to: e.target.value },
                  })
                }
              />
            </div>
            <div className="col-md-3">
              <button className="btn btn-success w-100" onClick={handleSubmit}>
                Submit Job
              </button>
            </div>
          </div>
        </div>
      )}

      <table className="table table-hover">
        <thead className="table-dark">
          <tr>
            <th>Job Type</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              onClick={() => navigate(`/jobs/${job.id}`)}
              style={{ cursor: "pointer" }}
            >
              <td>{job.job_type}</td>
              <td>
                <span
                  className={`badge bg-${statusBadge[job.status] || "secondary"}`}
                >
                  {job.status}
                </span>
              </td>
              <td>{new Date(job.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default JobList;
