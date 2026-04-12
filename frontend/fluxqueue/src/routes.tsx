// src/router.tsx
import { createBrowserRouter } from "react-router-dom";
import JobList from "./pages/JobList";
import JobDetail from "./pages/JobDetail";

const router = createBrowserRouter([
  {
    path: "/",
    element: <JobList />,
  },
  {
    path: "/jobs/:id",
    element: <JobDetail />,
  },
]);

export default router;
