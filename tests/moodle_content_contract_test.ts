import assert from "node:assert/strict";
import { AUDITED_FUNCTIONS, MoodleAdapter } from "../src/adapters/moodle.ts";

Deno.test("Moodle collection envelopes preserve pages/books/resources/urls instead of false empty coverage", async () => {
  const adapter = new MoodleAdapter({ origin: "https://moodle.example.org", token: "synthetic" }, {
    fetch: (_url, init) => {
      const fn = new URLSearchParams(String(init?.body)).get("wsfunction");
      if (fn === "core_webservice_get_site_info") {
        return Promise.resolve(
          Response.json({
            userid: 7,
            siteurl: "https://moodle.example.org",
            functions: AUDITED_FUNCTIONS.map((name) => ({ name })),
          }),
        );
      }
      const key: Record<string, string> = {
        mod_page_get_pages_by_courses: "pages",
        mod_book_get_books_by_courses: "books",
        mod_resource_get_resources_by_courses: "resources",
        mod_url_get_urls_by_courses: "urls",
        mod_feedback_get_feedbacks_by_courses: "feedbacks",
        mod_feedback_get_items: "items",
      };
      return Promise.resolve(
        Response.json({
          [key[fn!]]: [{ id: 42, name: "Source", externalurl: "https://example.org/reference" }],
          warnings: [],
        }),
      );
    },
  });
  for (
    const r of await Promise.all([
      adapter.getPages([1]),
      adapter.getBooks([1]),
      adapter.getResources([1]),
      adapter.getUrls([1]),
      adapter.getFeedbacks([1]),
      adapter.getFeedbackItems(2),
    ])
  ) {
    assert.equal(r.data?.length, 1);
    assert.equal(r.empty, false);
    assert.equal(r.coverage, "complete");
  }
});
Deno.test("external reference is not a Moodle download and never receives the Moodle token", async () => {
  const urls: string[] = [];
  const adapter = new MoodleAdapter({
    origin: "https://moodle.example.org",
    token: "synthetic-token",
  }, {
    fetch: (url, init) => {
      urls.push(String(url));
      const fn = new URLSearchParams(String(init?.body)).get("wsfunction");
      if (fn === "core_webservice_get_site_info") {
        return Promise.resolve(
          Response.json({
            userid: 7,
            siteurl: "https://moodle.example.org",
            functions: AUDITED_FUNCTIONS.map((name) => ({ name })),
          }),
        );
      }
      return Promise.resolve(
        Response.json([{
          id: 1,
          modules: [{
            id: 2,
            modname: "url",
            contents: [{
              type: "url",
              filename: "reference",
              fileurl: "https://example.org/article",
            }, { type: "url", filename: "unsafe", fileurl: "javascript:alert(1)" }],
          }],
        }]),
      );
    },
  });
  const r = await adapter.getCourseContents(1), serialized = JSON.stringify(r.data);
  assert.ok(serialized.includes("https://example.org/article"));
  assert.ok(serialized.includes("reference_only"));
  assert.ok(!serialized.includes("file_error"));
  assert.ok(!serialized.includes("javascript:"));
  assert.equal(adapter.listRegisteredFiles().length, 0);
  assert.ok(urls.every((u) => u.startsWith("https://moodle.example.org/")));
});

Deno.test("forum exporter url registers attachment and exact post beyond first thousand is verified",async()=>{
  const bytes=new TextEncoder().encode('synthetic attachment');
  const adapter=new MoodleAdapter({origin:'https://moodle.example.org',token:'synthetic-token'},{
    fetch:async(url,init)=>{
      if(String(url).includes('/webservice/pluginfile.php/'))return new Response(bytes,{headers:{'Content-Type':'text/plain'}});
      const fn=new URLSearchParams(String(init?.body)).get('wsfunction');
      if(fn==='core_webservice_get_site_info')return Response.json({userid:7,siteurl:'https://moodle.example.org',functions:AUDITED_FUNCTIONS.map(name=>({name}))});
      return Response.json({posts:Array.from({length:1005},(_,i)=>({id:i+1,parentid:i===0?0:1,subject:'Post '+i,message:'<p>Source</p>',attachments:i===1004?[{filename:'proof.txt',filesize:bytes.length,mimetype:'text/plain',url:'https://moodle.example.org/pluginfile.php/7/mod_forum/attachment/1005/proof.txt'}]:[]})),warnings:[]});
    }
  });
  const first=await adapter.getDiscussionPosts(9,{limit:1000});assert.equal(first.truncated,true);
  const exact=await adapter.getDiscussionPosts(9,{postId:1005});assert.equal(exact.coverage,'complete');assert.equal(exact.data?.length,1);
  const file=(exact.data![0].attachments as Array<{file:{file_id:string};url?:string}>)[0];
  assert.ok(file.file.file_id);assert.equal(file.url,undefined);
  const downloaded=await adapter.downloadFile(file.file.file_id);assert.deepEqual(downloaded.data?.bytes,bytes);
  const root=await adapter.getDiscussionPosts(9,{rootOnly:true});assert.equal(root.data?.[0].id,1);
});
