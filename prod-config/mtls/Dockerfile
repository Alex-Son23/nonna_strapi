FROM alpine:3.20

RUN apk add --no-cache openssl

COPY --chmod=755 issue.sh /usr/local/bin/issue-mtls-certificate

ENTRYPOINT ["/usr/local/bin/issue-mtls-certificate"]
