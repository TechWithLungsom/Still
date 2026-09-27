export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
    credentials: "same-origin",
  });
  const data = await response
    .json()
    .catch(() => ({ error: "The server returned an invalid response." }));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}
export function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error("You are offline."));
    socket.timeout(8000).emit(event, payload, (timeout, result) => {
      if (timeout)
        return reject(
          new Error("Connection timed out. Your message is safe in the queue."),
        );
      if (!result?.ok) {
        const error = new Error(result?.error || "Request failed.");
        error.status = result?.status;
        return reject(error);
      }
      resolve(result);
    });
  });
}
