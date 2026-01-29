export const TEACHER_EMAILS = [
  "sabkapremium22@gmail.com",
  "sonvirhts@gmail.com",
  "journyoflife1@gmail.com",
  "faujdarsonu908@gmail.com",
  "testyodha3@gmail.com",
];

export const isTeacherEmail = (email) => {
  if (!email) return false;
  return TEACHER_EMAILS.includes(String(email).trim().toLowerCase());
};
