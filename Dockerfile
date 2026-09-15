FROM nginx:alpine

COPY index.html /usr/share/nginx/html/index.html
COPY js /usr/share/nginx/html/js
COPY styles /usr/share/nginx/html/styles

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
