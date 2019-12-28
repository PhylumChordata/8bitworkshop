// ported from
// https://odensskjegg.home.blog/2018/12/29/recreating-the-commodore-64-user-guide-code-samples-in-cc65-part-three-sprites/

#include <stdio.h>
#include <stdlib.h>
#include <conio.h>
#include <peekpoke.h>
#include <c64.h>
#include <joystick.h>

/*{w:24,h:21,bpp:1,brev:1}*/
const char sprite[3*21] = {
  0x00,0x7F,0x00,0x01,0xFF,0xC0,0x03,0xFF,0xE0,
  0x03,0xE7,0xE0,0x07,0xD9,0xF0,0x07,0xDF,0xF0,
  0x07,0xD9,0xF0,0x03,0xE7,0xE0,0x03,0xFF,0xE0,
  0x03,0xFF,0xE0,0x02,0xFF,0xA0,0x01,0x7F,0x40,
  0x01,0x3E,0x40,0x00,0x9C,0x80,0x00,0x9C,0x80,
  0x00,0x49,0x00,0x00,0x49,0x00,0x00,0x3E,0x00,
  0x00,0x3E,0x00,0x00,0x3E,0x00,0x00,0x1C,0x00
};

// Raster wait with line argument
void rasterWait(unsigned char line) {
  while (VIC.rasterline < line) ;
}

int main (void)
{  
  int n;
  int x,y;
  // install the joystick driver
  joy_install (joy_static_stddrv);
  // set background color
  VIC.bgcolor0 = 3;
  // clear interrupts to avoid glitching
  __asm__("SEI"); 
  // set sprite bitmap data
  for (n = 0 ; n < sizeof(sprite) ; n++) {
    POKE(832 + n, sprite[n]);
  }
  // enable 1st sprite
  VIC.spr_ena = 0x01;
  // 2x zoom 1st sprite
  VIC.spr_exp_x = 0x01;
  VIC.spr_exp_y = 0x01;
  // set address of sprite data
  POKE(2040, 13);
  // set initial x/y positions
  x = 160;
  y = 128;
  // loop
  while (1) {
    // get joystick bits
    char joy = joy_read(0);
    // move sprite based on arrow keys
    if (JOY_LEFT(joy)) --x;
    if (JOY_UP(joy)) --y;
    if (JOY_RIGHT(joy)) ++x;
    if (JOY_DOWN(joy)) ++y;
    // set VIC registers based on position
    VIC.spr0_x = x;
    VIC.spr0_y = y;
    VIC.spr_hi_x = (x & 256) ? 1 : 0;
    // change color when we collide with background
    VIC.spr0_color = (VIC.spr_bg_coll & 1) ? 10 : 0;
    // wait for end of frame
    rasterWait(255);
  }  
  // uninstall joystick driver (not really necessary)
  joy_uninstall();
  return EXIT_SUCCESS;
}