// xhelper: one long-running X client for the hot paths, so a mouse move is a write to a pipe instead of a new xdotool process.
//
// stdin, one command per line:
//   m X Y      move the pointer
//   d B / u B  press / release button B (1 left, 2 middle, 3 right, 4/5 wheel)
//   c B N      click button B N times (the wheel)
// stdout, one line whenever the pointer's shape changes (and once at start):
//   C SERIAL W H XHOT YHOT RGBA-AS-HEX
// The shape comes from XFixes, so the browser can draw the real cursor (text beam, hand, ...) itself, with no delay, while the
// video carries none (ffmpeg -draw_mouse 0).
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/Xfixes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <unistd.h>

static void print_cursor(Display *dpy) {
  XFixesCursorImage *img = XFixesGetCursorImage(dpy);
  if (!img) return;
  printf("C %lu %d %d %d %d ", img->cursor_serial, img->width, img->height, img->xhot, img->yhot);
  // pixels are premultiplied ARGB in an unsigned long each; the browser wants straight RGBA
  for (int i = 0; i < img->width * img->height; i++) {
    unsigned long p = img->pixels[i];
    unsigned a = (p >> 24) & 255, r = (p >> 16) & 255, g = (p >> 8) & 255, b = p & 255;
    if (a && a < 255) { r = r * 255 / a; g = g * 255 / a; b = b * 255 / a; }
    printf("%02x%02x%02x%02x", r > 255 ? 255 : r, g > 255 ? 255 : g, b > 255 ? 255 : b, a);
  }
  printf("\n");
  fflush(stdout);
  XFree(img);
}

static void run(Display *dpy, char *line) {
  int a = 0, b = 0;
  switch (line[0]) {
    case 'm':
      if (sscanf(line + 1, "%d %d", &a, &b) == 2) XTestFakeMotionEvent(dpy, -1, a, b, CurrentTime);
      break;
    case 'd':
    case 'u':
      if (sscanf(line + 1, "%d", &a) == 1) XTestFakeButtonEvent(dpy, a, line[0] == 'd', CurrentTime);
      break;
    case 'c':
      if (sscanf(line + 1, "%d %d", &a, &b) == 2)
        for (int i = 0; i < b && i < 20; i++) {
          XTestFakeButtonEvent(dpy, a, True, CurrentTime);
          XTestFakeButtonEvent(dpy, a, False, CurrentTime);
        }
      break;
  }
}

int main(void) {
  Display *dpy = XOpenDisplay(NULL);
  if (!dpy) {
    fprintf(stderr, "xhelper: cannot open display\n");
    return 1;
  }
  int fixes_event, fixes_error;
  if (!XFixesQueryExtension(dpy, &fixes_event, &fixes_error)) {
    fprintf(stderr, "xhelper: no XFixes\n");
    return 1;
  }
  XFixesSelectCursorInput(dpy, DefaultRootWindow(dpy), XFixesDisplayCursorNotifyMask);
  print_cursor(dpy);

  char buf[65536];
  size_t used = 0;
  int xfd = ConnectionNumber(dpy);
  for (;;) {
    while (XPending(dpy)) {
      XEvent ev;
      XNextEvent(dpy, &ev);
      if (ev.type == fixes_event + XFixesCursorNotify) print_cursor(dpy);
    }
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(0, &fds);
    FD_SET(xfd, &fds);
    if (select(xfd + 1, &fds, NULL, NULL, NULL) < 0) continue;
    if (!FD_ISSET(0, &fds)) continue;
    ssize_t n = read(0, buf + used, sizeof buf - used - 1);
    if (n <= 0) return 0;  // the server went away
    used += n;
    buf[used] = 0;
    char *start = buf, *nl;
    while ((nl = strchr(start, '\n'))) {
      *nl = 0;
      run(dpy, start);
      start = nl + 1;
    }
    used -= start - buf;
    memmove(buf, start, used);
    if (used == sizeof buf - 1) used = 0;  // a line this long is garbage
    XFlush(dpy);
  }
}
