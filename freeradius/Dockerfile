FROM freeradius/freeradius-server:3.2.10-alpine

RUN apk add --no-cache postgresql-libs

COPY templates/clients.conf.template /etc/raddb/templates/clients.conf.template
COPY templates/sql.template /etc/raddb/templates/sql.template
COPY entrypoint.sh /captyn-entrypoint.sh
RUN chmod 0755 /captyn-entrypoint.sh && ln -sfn ../mods-available/sql /etc/raddb/mods-enabled/sql

ENTRYPOINT ["/captyn-entrypoint.sh"]
CMD ["radiusd"]
