"use client";
export function ErrorBox({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="error-box">
      {message}
    </p>
  ) : null;
}
