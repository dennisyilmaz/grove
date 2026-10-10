/** From d3-hierarchy's packSiblings/packEnclose (ISC, Mike Bostock), shuffle removed:
 *  input order is the layout, so the same repository always draws the same map. */
export const PACK = `
function place(b,a,c){
  var dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy,x,y,a2,b2;
  if(d2){
    a2=a.r+c.r;b2=b.r+c.r;a2*=a2;b2*=b2;
    if(a2>b2){x=(d2+b2-a2)/(2*d2);y=Math.sqrt(Math.max(0,b2/d2-x*x));
      c.x=b.x-x*dx-y*dy;c.y=b.y-x*dy+y*dx;}
    else{x=(d2+a2-b2)/(2*d2);y=Math.sqrt(Math.max(0,a2/d2-x*x));
      c.x=a.x+x*dx-y*dy;c.y=a.y+x*dy+y*dx;}
  }else{c.x=a.x+c.r;c.y=a.y;}
}
function meets(a,b){var dr=a.r+b.r-1e-6,dx=b.x-a.x,dy=b.y-a.y;return dr>0&&dr*dr>dx*dx+dy*dy;}
function score(n){var a=n._,b=n.next._,ab=a.r+b.r,
  dx=(a.x*b.r+b.x*a.r)/ab,dy=(a.y*b.r+b.y*a.r)/ab;return dx*dx+dy*dy;}
function Cell(c){this._=c;this.next=null;this.previous=null;}

function packSiblings(circles){
  var n=circles.length,a,b,c,aa,ca,i,j,k,sj,sk;
  if(!n)return 0;
  a=circles[0];a.x=0;a.y=0;
  if(n<2)return a.r;
  b=circles[1];a.x=-b.r;b.x=a.r;b.y=0;
  if(n<3)return a.r+b.r;
  place(b,a,c=circles[2]);
  a=new Cell(a);b=new Cell(b);c=new Cell(c);
  a.next=c.previous=b;b.next=a.previous=c;c.next=b.previous=a;
  pack:for(i=3;i<n;++i){
    place(a._,b._,c=circles[i]);c=new Cell(c);
    j=b.next;k=a.previous;sj=b._.r;sk=a._.r;
    do{
      if(sj<=sk){
        if(meets(j._,c._)){b=j;a.next=b;b.previous=a;--i;continue pack;}
        sj+=j._.r;j=j.next;
      }else{
        if(meets(k._,c._)){a=k;a.next=b;b.previous=a;--i;continue pack;}
        sk+=k._.r;k=k.previous;
      }
    }while(j!==k.next);
    c.previous=a;c.next=b;a.next=b.previous=c;b=c;
    aa=score(a);
    while((c=c.next)!==b){if((ca=score(c))<aa){a=c;aa=ca;}}
    b=a.next;
  }
  var chain=[b._];c=b;while((c=c.next)!==b)chain.push(c._);
  var e=enclose(chain);
  for(i=0;i<n;++i){a=circles[i];a.x-=e.x;a.y-=e.y;}
  return e.r;
}

function outside(a,b){var dr=a.r-b.r,dx=b.x-a.x,dy=b.y-a.y;return dr<0||dr*dr<dx*dx+dy*dy;}
function holds(a,b){var dr=a.r-b.r+1e-6,dx=b.x-a.x,dy=b.y-a.y;return dr>0&&dr*dr>dx*dx+dy*dy;}
function holdsAll(a,B){for(var i=0;i<B.length;++i)if(!holds(a,B[i]))return false;return true;}
function basis1(a){return {x:a.x,y:a.y,r:a.r};}
function basis2(a,b){
  var x1=a.x,y1=a.y,r1=a.r,x2=b.x,y2=b.y,r2=b.r,
    x21=x2-x1,y21=y2-y1,r21=r2-r1,l=Math.sqrt(x21*x21+y21*y21);
  return {x:(x1+x2+x21/l*r21)/2,y:(y1+y2+y21/l*r21)/2,r:(l+r1+r2)/2};
}
function basis3(a,b,c){
  var x1=a.x,y1=a.y,r1=a.r,x2=b.x,y2=b.y,r2=b.r,x3=c.x,y3=c.y,r3=c.r,
    a2=x1-x2,a3=x1-x3,b2=y1-y2,b3=y1-y3,c2=r2-r1,c3=r3-r1,
    d1=x1*x1+y1*y1-r1*r1,
    d2=d1-x2*x2-y2*y2+r2*r2,
    d3=d1-x3*x3-y3*y3+r3*r3,
    ab=a3*b2-a2*b3,
    xa=(b2*d3-b3*d2)/(ab*2)-x1,
    xb=(b3*c2-b2*c3)/ab,
    ya=(a3*d2-a2*d3)/(ab*2)-y1,
    yb=(a2*c3-a3*c2)/ab,
    A=xb*xb+yb*yb-1,
    B=2*(r1+xa*xb+ya*yb),
    C=xa*xa+ya*ya-r1*r1,
    r=-(Math.abs(A)>1e-6?(B+Math.sqrt(B*B-4*A*C))/(2*A):C/B);
  return {x:x1+xa+xb*r,y:y1+ya+yb*r,r:r};
}
function extend(B,p){
  var i,j;
  if(holdsAll(p,B))return [p];
  for(i=0;i<B.length;++i)
    if(outside(p,B[i])&&holdsAll(basis2(B[i],p),B))return [B[i],p];
  for(i=0;i<B.length-1;++i)for(j=i+1;j<B.length;++j)
    if(outside(basis2(B[i],B[j]),p)&&outside(basis2(B[i],p),B[j])&&outside(basis2(B[j],p),B[i])
      &&holdsAll(basis3(B[i],B[j],p),B))return [B[i],B[j],p];
  return null;
}
function crude(circles){
  var cx=0,cy=0,n=circles.length,i,r=0,d;
  for(i=0;i<n;++i){cx+=circles[i].x;cy+=circles[i].y;}
  cx/=n;cy/=n;
  for(i=0;i<n;++i){d=Math.hypot(circles[i].x-cx,circles[i].y-cy)+circles[i].r;if(d>r)r=d;}
  return {x:cx,y:cy,r:r};
}
// The basis search is exact but can fail on degenerate input; a bounding circle
// that is merely correct beats a layout that throws.
function enclose(circles){
  var i=0,n=circles.length,B=[],p,e=null,next;
  while(i<n){
    p=circles[i];
    if(e&&holds(e,p)){++i;continue;}
    next=extend(B,p);
    if(!next)return crude(circles);
    B=next;
    e=B.length===1?basis1(B[0]):B.length===2?basis2(B[0],B[1]):basis3(B[0],B[1],B[2]);
    i=0;
  }
  return e||{x:0,y:0,r:0};
}
`;
